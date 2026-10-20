const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

const { createClient } = require('@supabase/supabase-js');
const jose = require('jose');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://linentdgbyabgspedonn.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_cz6So10jN6_qyXtXPuE5Og_q-Azfa8v';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'sb_secret_yRhPOe9xxOgqLVEFP9aLYQ_q6H-1Dl6';
const SUPABASE_JWKS_URL = process.env.SUPABASE_JWKS_URL || `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`;

const isConfigured = Boolean(SUPABASE_URL && (SUPABASE_PUBLISHABLE_KEY || SUPABASE_SECRET_KEY));

// Supabase client with publishable key (client-facing / RLS-enforced)
const supabase = isConfigured
    ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: {
            persistSession: false,
            autoRefreshToken: false
        }
    })
    : null;

// Supabase admin client with secret key (bypasses RLS, full backend access)
const supabaseAdmin = isConfigured
    ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY || SUPABASE_PUBLISHABLE_KEY, {
        auth: {
            persistSession: false,
            autoRefreshToken: false
        }
    })
    : null;

// Remote JWKS set for verifying Supabase JWTs
let remoteJwks = null;
function getJwks() {
    if (!remoteJwks && SUPABASE_JWKS_URL) {
        remoteJwks = jose.createRemoteJWKSet(new URL(SUPABASE_JWKS_URL));
    }
    return remoteJwks;
}

/**
 * Verify a Supabase JWT token against the JWKS endpoint
 */
async function verifySupabaseJwt(token) {
    if (!token) return { valid: false, error: 'No token provided' };
    try {
        const jwks = getJwks();
        const { payload } = await jose.jwtVerify(token, jwks);
        return { valid: true, payload };
    } catch (err) {
        return { valid: false, error: err.message };
    }
}

/**
 * Check Supabase health and latency
 */
async function checkSupabaseHealth() {
    if (!isConfigured || !supabaseAdmin) {
        return { ok: false, error: 'Supabase credentials not configured' };
    }
    const start = Date.now();
    try {
        const { data, error } = await supabaseAdmin.from('school_info').select('id').limit(1);
        if (error) {
            return { ok: false, error: error.message, latencyMs: Date.now() - start };
        }
        return {
            ok: true,
            latencyMs: Date.now() - start,
            url: SUPABASE_URL,
            authenticatedAs: 'service_role'
        };
    } catch (err) {
        return { ok: false, error: err.message, latencyMs: Date.now() - start };
    }
}

function isSupabaseConfigured() {
    return isConfigured;
}

module.exports = {
    supabase,
    supabaseAdmin,
    isSupabaseConfigured,
    checkSupabaseHealth,
    verifySupabaseJwt,
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY,
    SUPABASE_JWKS_URL
};
