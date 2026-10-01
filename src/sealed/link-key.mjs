/**
 * @module cli/sealed/link-key
 * @description A link to an artifact encrypted end to end shares it only with
 *              its key in the fragment (D-20260930-04). Here a link is given the
 *              key this machine keeps for its artifact, in place of any fragment
 *              it had; with none kept - the artifact is not encrypted, or its
 *              key is elsewhere - it is the link as it was.
 *
 * @input A link, the artifact's id, a run's context `{ baseUrl, env }`
 * @output The link, with the key where one is kept
 * @dependencies cli/shared, cli/sealed/keyring
 */

import { linkWithKey } from '../shared.mjs';
import { keyringFor } from './keyring.mjs';

export async function withKnownKey(url, id, ctx) {
    const key = await keyringFor(ctx).get(ctx.baseUrl, id);
    return key === null ? url : linkWithKey(url, key);
}
