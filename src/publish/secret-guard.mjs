/**
 * @module cli/secret-guard
 * @description Files that hold keys are never sent unless named with
 *              `--allow-file`. Hidden files are left out anyway; this catches
 *              the rest that the editor accepts as code (JSON, YAML, INI and
 *              the like): by name - credentials, secrets, service accounts, SSH
 *              and TLS keys, key stores, Terraform state - and by what is inside:
 *              a private key block, or a token in the shape of Markest's,
 *              Stripe's, GitHub's, Slack's or AWS's. A publish is a link anyone
 *              who has it can read, so a false alarm costs a flag and a miss
 *              costs a key. Pure.
 *
 * @input A document's path; its text
 * @output The reason it looks like a secret, or null
 * @dependencies None
 */

const SECRET_NAMES = [
    /(^|[._-])(credentials?|secrets?)([._-]|$)/i,
    /^service[-_]?account.*\.json$/i,
    /^id_(rsa|dsa|ecdsa|ed25519)$/i,
    /\.(pem|key|p12|pfx|keystore|jks|kdbx|tfstate|tfvars|ovpn)$/i,
    /\.tfstate\.backup$/i,
];

const SECRET_CONTENT = [
    ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['markest_key', /\bmk_[a-z]+_[0-9a-f]{32,}\b/],
    ['stripe_key', /\b[rs]k_live_[0-9A-Za-z]{20,}\b/],
    ['github_token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
    ['slack_token', /\bxox[abprs]-[0-9A-Za-z-]{10,}/],
    ['aws_key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
];

/** Writing about secrets is not one: prose is judged by what it holds alone. */
const PROSE = /\.(md|markdown|mdown|mkd|txt|text|html?|xhtml)$/i;

/** Why a file of this name is taken for a secret, or null. */
export function secretByName(path) {
    const name = String(path).split('/').at(-1);
    if (PROSE.test(name)) return null;
    return SECRET_NAMES.some((pattern) => pattern.test(name)) ? 'secret_name' : null;
}

/** Which kind of secret this text holds, or null. */
export function secretInContent(text) {
    for (const [code, pattern] of SECRET_CONTENT) {
        if (pattern.test(text)) return code;
    }
    return null;
}
