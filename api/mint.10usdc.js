export default function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    if (req.method === "OPTIONS") return res.status(200).end();

    return res.status(402).json({
        "error": "Payment required to access this resource",
        "accepts": [
            {
                "scheme": "exact",
                "network": "base",
                "maxAmountRequired": "10000000",
                "resource": "https://402life.vercel.app/",
                "description": "Mint 100k 402人生. Cap for this endpoint is 100k $USDC.",
                "mimeType": "application/json",
                "payTo": "0xe6499924e979Af0A2F49A56bB4982866117Cd559",
                "maxTimeoutSeconds": 300,
                "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                "outputSchema": {
                    "input": { "type": "http", "method": "GET", "discoverable": true },
                    "output": {
                        "type": "object",
                        "properties": {
                            "requestId": { "type": "string" },
                            "status": { "type": "string" },
                            "queuedAt": { "type": "string" },
                            "deliveryNotice": { "type": "string" },
                            "userAddress": { "type": "string" },
                            "tokenAmount": { "type": "string" }
                        }
                    }
                },
                "extra": {
                    "recipientAddress": "0xe6499924e979Af0A2F49A56bB4982866117Cd559",
                    "name": "USD Coin",
                    "version": "2",
                    "primaryType": "TransferWithAuthorization"
                }
            }
        ],
        "x402Version": 1,
        "facilitator": "https://facilitator.thirdweb.com"
    });
}
