require("dotenv").config();
const express = require("express");

const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const swaggerUi = require("swagger-ui-express");
const swaggerJSDoc = require("swagger-jsdoc");

// ----- Firebase Admin init -----
// Uses Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS env var)
initializeApp({ credential: applicationDefault() }); // :contentReference[oaicite:4]{index=4}

const app = express();
app.use(express.json());

// ----- Swagger / OpenAPI -----
const swaggerSpec = swaggerJSDoc({
    definition: {
        openapi: "3.0.0",
        info: {
            title: "FCM Server API",
            version: "1.0.0",
            description: "API for registering device tokens and sending FCM data notifications.",
        },
        servers: [
            { url: "http://localhost:4000", description: "Local server" },
        ],
        components: {
            schemas: {
                RegisterDevice: {
                    type: "object",
                    required: ["userId", "token"],
                    properties: {
                        userId: { type: "string", example: "user_123" },
                        token: { type: "string", example: "fcm_token_here" },
                        platform: { type: "string", example: "android" },
                    },
                },
                UpdateToken: {
                    type: "object",
                    required: ["userId", "token"],
                    properties: {
                        userId: { type: "string", example: "user_123" },
                        token: { type: "string", example: "new_fcm_token" },
                        oldToken: { type: "string", example: "old_fcm_token" },
                        platform: { type: "string", example: "android" },
                    },
                },
                UnregisterDevice: {
                    type: "object",
                    required: ["userId", "token"],
                    properties: {
                        userId: { type: "string", example: "user_123" },
                        token: { type: "string", example: "fcm_token_here" },
                    },
                },
                SendNotification: {
                    type: "object",
                    required: ["userId", "data"],
                    properties: {
                        userId: { type: "string", example: "user_123" },
                        data: {
                            type: "object",
                            additionalProperties: { type: "string" },
                            example: { type: "chat", messageId: "abc123" },
                        },
                        android: {
                            type: "object",
                            example: { priority: "high" },
                            description: "Optional FCM Android config (e.g., priority, ttl)",
                        },
                    },
                },
                SendToToken: {
                    type: "object",
                    required: ["token", "data"],
                    properties: {
                        token: { type: "string", example: "fcm_token_here" },
                        data: {
                            type: "object",
                            additionalProperties: { type: "string" },
                            example: { type: "ping", timestamp: "1700000000" },
                        },
                        android: {
                            type: "object",
                            example: { priority: "high" },
                            description: "Optional FCM Android config (e.g., priority, ttl)",
                        },
                    },
                },
                StandardResponse: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean" },
                        error: { type: "string" },
                    },
                },
            },
        },
    },
    apis: [__filename],
});

app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Health check
/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 */
app.get("/health", (req, res) => {
    res.json({ ok: true });
});

// ----- In-memory token store (DEMO) -----
// In production, replace with DB (Postgres/Mongo/Redis/Firestore)
const tokensByUser = new Map(); // userId -> Set(tokens)
const metaByToken = new Map();  // token -> { userId, platform, updatedAt }

// Helpers
function upsertToken({ userId, token, platform }) {
    if (!tokensByUser.has(userId)) tokensByUser.set(userId, new Set());
    tokensByUser.get(userId).add(token);

    metaByToken.set(token, {
        userId,
        platform: platform || "android",
        updatedAt: new Date().toISOString(),
    });
}

function removeToken({ userId, token }) {
    if (userId && tokensByUser.has(userId)) {
        tokensByUser.get(userId).delete(token);
        if (tokensByUser.get(userId).size === 0) tokensByUser.delete(userId);
    }
    metaByToken.delete(token);
}

function ensureStringData(data) {
    // FCM data payload works best as string->string
    const out = {};
    for (const [k, v] of Object.entries(data || {})) {
        out[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return out;
}

// ----- Routes -----

// 1) Register token (called after app obtains token)
/**
 * @swagger
 * /devices/register:
 *   post:
 *     summary: Register a device token for a user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegisterDevice'
 *     responses:
 *       200:
 *         description: Registered
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StandardResponse'
 *       400:
 *         description: Missing required fields
 */
app.post("/devices/register", (req, res) => {
    const { userId, token, platform } = req.body || {};

    if (!userId || !token) {
        return res.status(400).json({ ok: false, error: "userId and token are required" });
    }

    console.log("[FCM] register token", { userId, token, platform: platform || "android" });
    upsertToken({ userId, token, platform: platform || "android" });

    res.json({ ok: true });
});

// 2) Token refresh update
// Mobile should call this from onTokenRefresh()
// Ideally send oldToken too (if you store it client-side) so server can remove it
/**
 * @swagger
 * /devices/token:
 *   put:
 *     summary: Update a device token for a user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateToken'
 *     responses:
 *       200:
 *         description: Updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StandardResponse'
 *       400:
 *         description: Missing required fields
 */
app.put("/devices/token", (req, res) => {
    const { userId, token, oldToken, platform } = req.body || {};

    if (!userId || !token) {
        return res.status(400).json({ ok: false, error: "userId and token are required" });
    }

    console.log("[FCM] update token", {
        userId,
        token,
        oldToken,
        platform: platform || "android",
    });
    if (oldToken && oldToken !== token) {
        removeToken({ userId, token: oldToken });
    }

    upsertToken({ userId, token, platform: platform || "android" });

    res.json({ ok: true });
});

// 3) Unregister token (logout / disable notifications)
/**
 * @swagger
 * /devices/unregister:
 *   delete:
 *     summary: Unregister a device token for a user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UnregisterDevice'
 *     responses:
 *       200:
 *         description: Unregistered
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StandardResponse'
 *       400:
 *         description: Missing required fields
 */
app.delete("/devices/unregister", (req, res) => {
    const { userId, token } = req.body || {};
    if (!userId || !token) {
        return res.status(400).json({ ok: false, error: "userId and token are required" });
    }
    removeToken({ userId, token });
    res.json({ ok: true });
});

// 4) Send data-only notification to all devices of a user
/**
 * @swagger
 * /notifications/send:
 *   post:
 *     summary: Send data-only notification to all devices of a user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SendNotification'
 *     responses:
 *       200:
 *         description: Sent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 successCount: { type: integer }
 *                 failureCount: { type: integer }
 *       404:
 *         description: No tokens for user
 *       500:
 *         description: Firebase error
 */
app.post("/notifications/send", async (req, res) => {
    const { userId, data, android } = req.body || {};
    if (!userId || !data) {
        return res.status(400).json({ ok: false, error: "userId and data are required" });
    }

    const tokenSet = tokensByUser.get(userId);
    if (!tokenSet || tokenSet.size === 0) {
        return res.status(404).json({ ok: false, error: "No tokens for this user" });
    }

    const tokens = Array.from(tokenSet);
    const payloadData = ensureStringData(data);

    try {
        // sendEachForMulticast is preferred; sendMulticast is deprecated :contentReference[oaicite:5]{index=5}
        const resp = await getMessaging().sendEachForMulticast({
            tokens,
            data: payloadData,
            android: android || {
                priority: "high", // important for data-only background delivery :contentReference[oaicite:6]{index=6}
            },
        });

        // Cleanup invalid tokens (common production hygiene)
        resp.responses.forEach((r, idx) => {
            if (!r.success) {
                const t = tokens[idx];
                const code = r.error?.code || "";
                // token not valid anymore => remove it
                if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
                    const meta = metaByToken.get(t);
                    if (meta?.userId) removeToken({ userId: meta.userId, token: t });
                }
            }
        });

        res.json({
            ok: true,
            successCount: resp.successCount,
            failureCount: resp.failureCount,
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
    }
});

// 5) Send data-only notification to a single token (useful for testing)
/**
 * @swagger
 * /notifications/sendToToken:
 *   post:
 *     summary: Send data-only notification to a single device token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SendToToken'
 *     responses:
 *       200:
 *         description: Sent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 messageId: { type: string }
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Firebase error
 */
app.post("/notifications/sendToToken", async (req, res) => {
    const { token, data, android } = req.body || {};
    if (!token || !data) {
        return res.status(400).json({ ok: false, error: "token and data are required" });
    }

    try {
        const messageId = await getMessaging().send({
            token,
            data: ensureStringData(data),
            android: android || { priority: "high" }, // :contentReference[oaicite:7]{index=7}
        });

        res.json({ ok: true, messageId });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
    }
});

app.listen(process.env.PORT || 4000, () => {
    console.log(`Server running on port ${process.env.PORT || 4000}`);
});
