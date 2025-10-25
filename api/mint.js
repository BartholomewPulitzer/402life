import { ethers } from "ethers";

const USDC_EIP3009_ABI = [
    "function name() view returns (string)",
    "function authorizationState(address authorizer, bytes32 nonce) view returns (uint8)", // 有的实现返回 bool，这里用 uint8 也兼容
    "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)"
];

const CHAIN_ID = 8453; // Base mainnet
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
function b64urlToB64(input) {
    let s = input.replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4;
    if (pad === 2) s += "==";
    else if (pad === 3) s += "=";
    else if (pad !== 0) throw new Error("Invalid base64/base64url string");
    return s;
}
export function getPKsFromCSV(envName = "RELAYER_PKS") {
    const raw = process.env[envName] ?? "";
    return raw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => {
            if (!s.startsWith("0x")) return "0x" + s; // 兼容无 0x 的粘贴
            return s;
        });
}

export function getRandomWalletFromEnv(rpcEnv = "BASE_RPC_URL", keysEnv = "RELAYER_PKS") {
    const pks = getPKsFromCSV(keysEnv);
    const pk = pickRandomPK(pks);


    return pk
}
export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Payment");
    if (req.method === "OPTIONS") return res.status(200).end();

    // 仅支持 GET：带 X-Payment 的 GET 触发代发；否则返回 402
    if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

    // 1) 是否带 X-Payment
    const hdr = req.headers["x-payment"];
    const xpay = Array.isArray(hdr) ? hdr[0] : hdr;
    if (!xpay) {
        return res.status(402).json({
            error: "Payment required to access this resource",
            accepts: [
                {
                    scheme: "exact",
                    network: "base",
                    maxAmountRequired: "1000000",
                    resource: "https://402life.vercel.app/",
                    description: "Mint 10k 402人生. Cap for this endpoint is 100k $USDC.",
                    mimeType: "application/json",
                    payTo: "0x0aE4829C69d2aC57fB04597308836DfbA79a4CdF",
                    maxTimeoutSeconds: 300,
                    asset: USDC_ADDRESS,
                    outputSchema: {
                        input: { type: "http", method: "GET", discoverable: true },
                        output: {
                            type: "object",
                            properties: {
                                requestId: { type: "string" },
                                status: { type: "string" },
                                queuedAt: { type: "string" },
                                deliveryNotice: { type: "string" },
                                userAddress: { type: "string" },
                                tokenAmount: { type: "string" }
                            }
                        }
                    },
                    extra: {
                        recipientAddress: "0x0aE4829C69d2aC57fB04597308836DfbA79a4CdF",
                        name: "USD Coin",
                        version: "2",
                        primaryType: "TransferWithAuthorization"
                    }
                }
            ],
            x402Version: 1,
            facilitator: "https://facilitator.thirdweb.com"
        });
    }

    try {
        // 2) Base64/URL 解码 + 解析 JSON
        const b64 = b64urlToB64(xpay.trim());
        const jsonStr = Buffer.from(b64, "base64").toString("utf8");
        const decoded = JSON.parse(jsonStr);

        // 3) 基础校验
        if (decoded.x402Version !== 1) return res.status(400).json({ error: "Unsupported x402Version" });
        if (String(decoded.scheme).toLowerCase() !== "exact") return res.status(400).json({ error: "Unsupported scheme" });
        if (String(decoded.network).toLowerCase() !== "base") return res.status(400).json({ error: "Network must be base" });

        const signature = decoded?.payload?.signature;
        const auth = decoded?.payload?.authorization;
        if (
            !signature ||
            !auth?.from || !auth?.to || !auth?.value ||
            typeof auth?.validAfter === "undefined" || typeof auth?.validBefore === "undefined" ||
            !auth?.nonce
        ) {
            return res.status(400).json({ error: "Bad payload.authorization/signature" });
        }

        // 4) 连接链、中继钱包、USDC 合约
        const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
        const relayer = new ethers.Wallet(getRandomWalletFromEnv(), provider);
        const token = new ethers.Contract(USDC_ADDRESS, USDC_EIP3009_ABI, relayer);

        // 5) 重建 EIP-712 Domain（链上读取 name()；USDC 常见 version="2"）
        const onchainName = await token.name();
        const domain = {
            name: onchainName,
            version: "2",
            chainId: CHAIN_ID,
            verifyingContract: USDC_ADDRESS
        };
        const types = {
            TransferWithAuthorization: [
                { name: "from", type: "address" },
                { name: "to", type: "address" },
                { name: "value", type: "uint256" },
                { name: "validAfter", type: "uint256" },
                { name: "validBefore", type: "uint256" },
                { name: "nonce", type: "bytes32" }
            ]
        };

        // 6) 规范化 message
        const message = {
            from: ethers.getAddress(auth.from),
            to: ethers.getAddress(auth.to),
            value: BigInt(auth.value),
            validAfter: BigInt(auth.validAfter),
            validBefore: BigInt(auth.validBefore),
            nonce: auth.nonce
        };

        // 7) 验签：签名者必须等于 from
        const recovered = ethers.verifyTypedData(domain, types, message, signature);
        if (recovered.toLowerCase() !== message.from.toLowerCase()) {
            return res.status(400).json({ error: "Bad signature: signer != from", recovered });
        }

        // 8) 时间窗口检查
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (message.validBefore <= now) return res.status(400).json({ error: "Authorization expired" });
        if (message.validAfter > 0n && message.validAfter > now) {
            return res.status(400).json({ error: "Authorization not yet valid" });
        }

        // 9) 防重放：authorizationState
        // const st = await token.authorizationState(message.from, message.nonce);
        // const used = (st === true) || (Number(st) === 1);
        // if (used) return res.status(409).json({ error: "Authorization already used" });

        // // 10) 估算 gas（可捕获余额不足/过期/nonce 冲突等原因）
        // const { v, r, s } = ethers.Signature.from(signature);
        // try {
        //     await token.estimateGas.transferWithAuthorization(
        //         message.from, message.to, message.value,
        //         message.validAfter, message.validBefore, message.nonce,
        //         v, r, s
        //     );
        // } catch (e) {
        //     return res.status(400).json({ error: "Gas estimation failed", reason: e?.message ?? String(e) });
        // }
        const { v, r, s } = ethers.Signature.from(signature);

        // 11) 发送交易并等待回执
        const tx = await token.transferWithAuthorization(
            message.from, message.to, message.value,
            message.validAfter, message.validBefore, message.nonce,
            v, r, s
        );
        const rcpt = await tx.wait();

        return res.status(200).json({
            ok: true,
            txHash: tx.hash,
            blockNumber: rcpt?.blockNumber,
            explorer: `https://basescan.org/tx/${tx.hash}`
        });

    } catch (err) {
        console.error("pay handler error:", err);
        return res.status(500).json({ error: "Internal error", reason: err?.message ?? String(err) });
    }
}
