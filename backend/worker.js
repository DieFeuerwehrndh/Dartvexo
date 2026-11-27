
const ALLOWED_ORIGIN = "https://diefeuerwehrndh.github.io";
const FRONTEND_URL = "https://diefeuerwehrndh.github.io/Dartvexo/";
const REDIRECT_URI =
    "https://dartvexo.niclasbehrens6.workers.dev/auth/patreon/callback";

const CAMPAIGN_ID = "17093464";
const CLUB_SESSION_TTL = 60 * 60 * 24 * 365;

// CORS
function corsHeaders(origin) {
    return {
        "Access-Control-Allow-Origin":
            origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Vary": "Origin",
        "Content-Type": "application/json; charset=utf-8"
    };
}

// JSON-Antwort
function json(data, headers, status = 200) {
    return Response.json(data, { status, headers });
}

// Zufälligen Sitzungscode erzeugen
function randomToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);

    return btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
}

// Weiterleitung
function redirect(url) {
    return Response.redirect(url, 302);
}

// Patreon-Mitgliedschaft prüfen
async function getPatreonIdentity(accessToken) {
    const apiUrl = new URL(
        "https://www.patreon.com/api/oauth2/v2/identity"
    );

    apiUrl.searchParams.set("include", "memberships");
    apiUrl.searchParams.set(
        "fields[member]",
        "patron_status,currently_entitled_amount_cents"
    );
    apiUrl.searchParams.set("fields[user]", "full_name");

    const response = await fetch(apiUrl, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json"
        }
    });

    if (!response.ok) {
        throw new Error("PATREON_IDENTITY_FAILED");
    }

    const result = await response.json();

    const memberships =
        result.data?.relationships?.memberships?.data || [];

    const activeMembership = memberships.some(member => {
        const campaignId =
            member.relationships?.campaign?.data?.id;

        return (
            campaignId === CAMPAIGN_ID &&
            member.attributes?.patron_status === "active_patron" &&
            Number(
                member.attributes?.currently_entitled_amount_cents || 0
            ) > 0
        );
    });

    return {
        userId: result.data?.id || null,
        name: result.data?.attributes?.full_name || "Patreon-Nutzer",
        hasAccess: activeMembership
    };
}

// Patreon-Token austauschen oder erneuern
async function exchangeToken(env, body) {
    const form = new URLSearchParams({
        grant_type: body.grant_type,
        client_id: env.PATREON_CLIENT_ID,
        client_secret: env.PATREON_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI
    });

    if (body.grant_type === "authorization_code") {
        form.set("code", body.code);
    } else {
        form.set("refresh_token", body.refresh_token);
    }

    const response = await fetch(
        "https://www.patreon.com/api/oauth2/token",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: form
        }
    );

    if (!response.ok) {
        throw new Error("PATREON_TOKEN_EXCHANGE_FAILED");
    }

    return response.json();
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get("Origin") || "";
        const headers = corsHeaders(origin);
        const url = new URL(request.url);

        // CORS-Vorab-Anfrage
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers
            });
        }

        // Patreon-Kampagne abrufen
        if (
            request.method === "GET" &&
            url.pathname === "/api/setup/campaign"
        ) {
            if (!env.PATREON_CAT) {
                return json({
                    success: false,
                    error: "SECRET_MISSING"
                }, headers, 500);
            }

            try {
                const response = await fetch(
                    "https://www.patreon.com/api/oauth2/v2/campaigns",
                    {
                        headers: {
                            Authorization: `Bearer ${env.PATREON_CAT}`,
                            Accept: "application/json"
                        }
                    }
                );

                const result = await response.json();

                if (!response.ok) {
                    return json({
                        success: false,
                        error: "PATREON_API_ERROR",
                        status: response.status
                    }, headers, 502);
                }

                return json({
                    success: true,
                    campaigns: (result.data || []).map(campaign => ({
                        id: campaign.id,
                        name: campaign.attributes?.name ||
                            "Unbenannte Kampagne"
                    }))
                }, headers);
            } catch {
                return json({
                    success: false,
                    error: "REQUEST_FAILED"
                }, headers, 502);
            }
        }

        // Gemeinsamen Zugangscode aktivieren
        // Unterstützt Vereinscode und Admin-Code
        if (
            request.method === "POST" &&
            url.pathname === "/api/access/activate"
        ) {
            let body;

            try {
                body = await request.json();
            } catch {
                return json({
                    success: false,
                    error: "INVALID_JSON"
                }, headers, 400);
            }

            const submittedCode = String(body.code || "").trim();

            if (!submittedCode) {
                return json({
                    success: false,
                    error: "CODE_MISSING"
                }, headers, 400);
            }

            const adminCode = String(env.ADMIN_ACCESS_CODE || "");
            const clubCode = String(env.CLUB_ACTIVATION_CODE || "");

            let accessType = "";

            // Admin-Code hat Vorrang
            if (adminCode && submittedCode === adminCode) {
                accessType = "admin";
            } else if (clubCode && submittedCode === clubCode) {
                accessType = "club";
            }

            if (!accessType) {
                return json({
                    success: false,
                    error: "INVALID_ACCESS_CODE"
                }, headers, 401);
            }

            const sessionToken = randomToken();

            const userName = accessType === "admin"
                ? "DartVexo-Admin"
                : "Vereinszugang";

            const sessionData = {
                type: accessType,
                user: {
                    name: userName,
                    hasAccess: true
                }
            };

            // Gerätename nur für Vereinszugang speichern
            if (accessType === "club") {
                sessionData.deviceName = String(
                    body.deviceName || "Vereinsgerät"
                ).slice(0, 40);
            }

            await env.SESSIONS.put(
                `session:${sessionToken}`,
                JSON.stringify(sessionData),
                { expirationTtl: CLUB_SESSION_TTL }
            );

            return json({
                success: true,
                authenticated: true,
                hasAccess: true,
                isAdmin: accessType === "admin",
                isClub: accessType === "club",
                sessionToken,
                user: {
                    name: userName
                }
            }, headers);
        }

        // Patreon-Login starten
        if (
            request.method === "GET" &&
            url.pathname === "/auth/patreon/login"
        ) {
            if (!env.PATREON_CLIENT_ID) {
                return json({
                    success: false,
                    error: "CLIENT_ID_MISSING"
                }, headers, 500);
            }

            const state = randomToken();

            await env.SESSIONS.put(
                `oauth_state:${state}`,
                "valid",
                { expirationTtl: 600 }
            );

            const authUrl = new URL(
                "https://www.patreon.com/oauth2/authorize"
            );

            authUrl.searchParams.set("response_type", "code");
            authUrl.searchParams.set(
                "client_id",
                env.PATREON_CLIENT_ID
            );
            authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
            authUrl.searchParams.set(
                "scope",
                "identity identity.memberships"
            );
            authUrl.searchParams.set("state", state);

            return redirect(authUrl.toString());
        }

        // Patreon-Callback nach Zustimmung
        if (
            request.method === "GET" &&
            url.pathname === "/auth/patreon/callback"
        ) {
            const code = url.searchParams.get("code");
            const state = url.searchParams.get("state");

            if (!code || !state) {
                return redirect(
                    FRONTEND_URL + "?patreon_error=missing_parameters"
                );
            }

            const stateKey = `oauth_state:${state}`;
            const validState = await env.SESSIONS.get(stateKey);

            await env.SESSIONS.delete(stateKey);

            if (!validState) {
                return redirect(
                    FRONTEND_URL + "?patreon_error=invalid_state"
                );
            }

            try {
                const token = await exchangeToken(env, {
                    grant_type: "authorization_code",
                    code
                });

                const identity = await getPatreonIdentity(
                    token.access_token
                );

                const handoffCode = randomToken();

                await env.SESSIONS.put(
                    `handoff:${handoffCode}`,
                    JSON.stringify({
                        accessToken: token.access_token,
                        refreshToken: token.refresh_token,
                        expiresAt: Date.now() +
                            Number(token.expires_in || 3600) * 1000,
                        user: identity
                    }),
                    { expirationTtl: 90 }
                );

                return redirect(
                    FRONTEND_URL +
                    "?patreon_code=" +
                    encodeURIComponent(handoffCode)
                );
            } catch {
                return redirect(
                    FRONTEND_URL + "?patreon_error=login_failed"
                );
            }
        }

        // Einmaligen Rücksprung-Code gegen Sitzung tauschen
        if (
            request.method === "POST" &&
            url.pathname === "/api/auth/redeem"
        ) {
            let body;

            try {
                body = await request.json();
            } catch {
                return json({
                    success: false
                }, headers, 400);
            }

            if (!body.code) {
                return json({
                    success: false,
                    error: "CODE_MISSING"
                }, headers, 400);
            }

            const handoffKey = `handoff:${body.code}`;
            const handoff = await env.SESSIONS.get(handoffKey);

            await env.SESSIONS.delete(handoffKey);

            if (!handoff) {
                return json({
                    success: false,
                    error: "CODE_INVALID_OR_EXPIRED"
                }, headers, 401);
            }

            const data = JSON.parse(handoff);
            const sessionToken = randomToken();

            await env.SESSIONS.put(
                `session:${sessionToken}`,
                JSON.stringify(data),
                { expirationTtl: 60 * 60 * 24 * 30 }
            );

            return json({
                success: true,
                sessionToken,
                user: {
                    name: data.user.name,
                    hasAccess: data.user.hasAccess
                }
            }, headers);
        }

        // Sitzung und Zugang prüfen
        if (
            request.method === "GET" &&
            url.pathname === "/api/auth/status"
        ) {
            const authorization =
                request.headers.get("Authorization") || "";

            const sessionToken = authorization.startsWith("Bearer ")
                ? authorization.slice(7)
                : "";

            if (!sessionToken) {
                return json({
                    success: false,
                    authenticated: false
                }, headers, 401);
            }

            const sessionKey = `session:${sessionToken}`;
            const stored = await env.SESSIONS.get(sessionKey);

            if (!stored) {
                return json({
                    success: false,
                    authenticated: false
                }, headers, 401);
            }

            let data = JSON.parse(stored);

            // Vereins- und Adminzugang prüfen
            if (data.type === "club" || data.type === "admin") {
                await env.SESSIONS.put(
                    sessionKey,
                    JSON.stringify(data),
                    { expirationTtl: CLUB_SESSION_TTL }
                );

                return json({
                    success: true,
                    authenticated: true,
                    hasAccess: true,
                    isAdmin: data.type === "admin",
                    isClub: data.type === "club",
                    user: {
                        name: data.user.name
                    }
                }, headers);
            }

            // Patreon-Sitzung und Mitgliedschaft prüfen
            try {
                if (Date.now() >= data.expiresAt) {
                    const refreshed = await exchangeToken(env, {
                        grant_type: "refresh_token",
                        refresh_token: data.refreshToken
                    });

                    data.accessToken = refreshed.access_token;
                    data.refreshToken = refreshed.refresh_token ||
                        data.refreshToken;
                    data.expiresAt = Date.now() +
                        Number(refreshed.expires_in || 3600) * 1000;
                }

                data.user = await getPatreonIdentity(data.accessToken);

                await env.SESSIONS.put(
                    sessionKey,
                    JSON.stringify(data),
                    { expirationTtl: 60 * 60 * 24 * 30 }
                );

                return json({
                    success: true,
                    authenticated: true,
                    hasAccess: data.user.hasAccess,
                    isAdmin: false,
                    isClub: false,
                    user: {
                        name: data.user.name
                    }
                }, headers);
            } catch {
                await env.SESSIONS.delete(sessionKey);

                return json({
                    success: false,
                    authenticated: false,
                    error: "PATREON_CHECK_FAILED"
                }, headers, 401);
            }
        }

        // Abmelden
        if (
            request.method === "POST" &&
            url.pathname === "/api/auth/logout"
        ) {
            const authorization =
                request.headers.get("Authorization") || "";

            const sessionToken = authorization.startsWith("Bearer ")
                ? authorization.slice(7)
                : "";

            if (sessionToken) {
                await env.SESSIONS.delete(
                    `session:${sessionToken}`
                );
            }

            return json({
                success: true
            }, headers);
        }

        // Backend testen
        if (
            request.method === "GET" &&
            url.pathname === "/api/health"
        ) {
            return json({
                success: true,
                app: "DartVexo",
                message: "Backend ist erreichbar."
            }, headers);
        }

        // Unbekannte Route
        return json({
            success: false,
            message: "Diese Route existiert nicht."
        }, headers, 404);
    }
};
