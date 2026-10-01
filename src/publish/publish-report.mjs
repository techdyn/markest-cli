/**
 * @module cli/publish/publish-report
 * @description What a publish says, and its exit code: 0 done, 1 failed or done
 *              only in part, 3 waiting for the account holder to confirm
 *              publishing, 4 the folder cannot be published as it is and nothing
 *              was sent. Read by a person, stdout is the artifact's address alone
 *              - `url=$(markest publish docs)` works - and everything else goes
 *              to stderr; with `--json` stdout is one object. Pure.
 *
 * @input A publish result
 * @output The exit code; `{ stdout, stderr }` or one line of JSON
 * @dependencies cli/core/output
 */

import { EXIT, printable } from '../core/output.mjs';

export const MAX_SKIPPED_LISTED = 100;

const BY_STATUS = {
    published: EXIT.OK,
    updated: EXIT.OK,
    unchanged: EXIT.OK,
    dry_run: EXIT.OK,
    approval_required: EXIT.AWAITING_APPROVAL,
    incomplete: EXIT.FAILED,
    failed: EXIT.FAILED,
    refused: EXIT.REFUSED,
    usage: EXIT.USAGE,
};

export function exitCodeFor(result) {
    return BY_STATUS[result.status] ?? EXIT.FAILED;
}

export function renderJson(result) {
    const skipped = result.skipped ?? [];
    return JSON.stringify({
        ...result,
        exit_code: exitCodeFor(result),
        skipped: skipped.slice(0, MAX_SKIPPED_LISTED),
        skipped_total: skipped.length,
        skipped_truncated: skipped.length > MAX_SKIPPED_LISTED,
    }) + '\n';
}

const REASONS = {
    hidden: 'hidden',
    generated: 'dependencies',
    output: 'build output (--include-output sends it)',
    ignored: 'ignored',
    symlink: 'a link',
    special: 'not a file',
    type: 'not a document or image',
    secret: 'looks like a secret (--allow-file sends it)',
    too_large: 'too large',
    not_text: 'not UTF-8 text',
    invalid_path: 'a name the site refuses',
    path_collision: 'differs from another only in case or accents',
    unreadable: 'unreadable',
};

const WARNINGS = {
    unpublished_image: 'shows an image that is not being sent',
    image_link: 'links to an image; only an image shown with ![...](...) is displayed',
    html_local_resource: 'loads a stylesheet or script from beside it, which a published page cannot',
    html_page_link: 'links to another page, which cannot open inside a published page',
    outside_folder: 'points outside the folder',
    key_not_kept: 'could not keep the key; keep the link printed, which holds it',
};

function summary(result) {
    const lines = [];
    const byReason = new Map();
    for (const skip of result.skipped ?? []) byReason.set(skip.reason, (byReason.get(skip.reason) ?? 0) + 1);
    if (byReason.size > 0) {
        lines.push('Left out: ' + [...byReason].map(([reason, count]) => count + ' ' + (REASONS[reason] ?? reason)).join(', ') + '.');
        for (const skip of result.skipped.filter((one) => one.reason === 'secret')) lines.push('  not sent: ' + printable(skip.path));
    }
    for (const warning of result.warnings ?? []) {
        lines.push('Warning: ' + printable(warning.path) + ' ' + (WARNINGS[warning.code] ?? warning.code) + ': ' + printable(warning.target));
    }
    for (const refused of result.images?.refused ?? []) lines.push('Image refused: ' + printable(refused.path) + ': ' + printable(refused.error));
    for (const error of result.errors ?? []) {
        lines.push('Error: ' + error.code + (error.path ? ' ' + printable(error.path) : '') + (error.target ? ' (' + printable(error.target) + ')' : '')
            + (error.limit !== undefined ? ', limit ' + error.limit : ''));
    }
    return lines;
}

export function renderHuman(result) {
    const out = [];
    const err = summary(result);
    switch (result.status) {
        case 'dry_run':
            out.push('Would publish "' + printable(result.title) + '", opening on ' + printable(result.default_path ?? '(unchanged)') + ':');
            out.push('  ' + result.documents.created + ' new, ' + result.documents.updated + ' changed, ' + result.documents.unchanged
                + ' unchanged and ' + result.documents.deleted + ' removed documents; ' + result.images.uploaded.length + ' images to upload.');
            break;
        case 'approval_required':
            out.push(result.url);
            err.push('Making it public needs your confirmation: open ' + printable(result.approval_url) + '. Nothing is public until you approve it.');
            break;
        case 'incomplete':
            out.push(result.url);
            err.push('Published, but not everything was accepted: see above.');
            break;
        case 'failed':
        case 'refused':
            err.push('markest: ' + printable(result.error));
            if (result.url) err.push('The artifact so far: ' + result.url);
            break;
        default:
            out.push(result.url);
            if (result.status === 'unchanged') err.push('Nothing changed.');
            // The address is the key: say so, once, where a person reads it
            if (result.encrypted) err.push('Encrypted end to end: the key is in this link and kept on this machine (markest keys). Whoever has the link can read it.');
    }
    return { stdout: out.map((line) => line + '\n').join(''), stderr: err.map((line) => line + '\n').join('') };
}
