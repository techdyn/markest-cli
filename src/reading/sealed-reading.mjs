/**
 * @module cli/reading/sealed-reading
 * @description An artifact encrypted end to end, as the site hands it over,
 *              opened on this machine: with the key in the link it was named by,
 *              else the one this machine keeps for it. The key is kept for
 *              later only when asked (`--remember`), as a reader's browser keeps
 *              it only for the tab. Without a key there is nothing to read: the
 *              site holds only envelopes, so it is refused, saying how to give one.
 *
 * @input An artifact from cli/reading/artifact-source; a run's context `{ reference, remember, baseUrl, env }`
 * @output The artifact, its documents' text opened
 * @dependencies cli/core/command-kit, cli/sealed/sealing, cli/sealed/keyring
 */

import { Refused } from '../core/command-kit.mjs';
import { keyIn, openAll } from '../sealed/sealing.mjs';
import { keyringFor } from '../sealed/keyring.mjs';

export async function openIfSealed(artifact, ctx) {
    if (!artifact.sealed) return artifact;
    const keyring = keyringFor(ctx);
    const given = keyIn(ctx.reference);
    const keyText = given ?? await keyring.get(ctx.baseUrl, artifact.id);
    if (keyText === null) {
        throw new Refused('This artifact is encrypted end to end, and this machine keeps no key for it. Name it by its whole link, the one ending #key=...');
    }
    const documents = await openAll(keyText, artifact.documents);
    if (given !== null && ctx.remember) await keyring.remember(ctx.baseUrl, artifact.id, given, artifact.title);
    return { ...artifact, documents };
}
