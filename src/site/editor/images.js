/**
 * @module editor/images
 * @description Images in the editor. A file dropped onto the text or pasted into
 *              it goes in where the cursor is, the way the document shows images:
 *              markdown `![alt](url)`, an HTML `<img>`, or the bare address in code.
 *              One chosen in the Images popover is only uploaded; it goes into the
 *              text when Insert is pressed. On a saved paste an
 *              image is sent in pieces (editor/image-transfer), two
 *              at a time and the rest waiting their turn, each one announced to
 *              the upload list; a placed one holds its place with an `uploading:`
 *              address, becomes the image when it is stored, keeps its place while
 *              paused or waiting to be resumed, and gives it back - saying why when
 *              refused - when cancelled or refused. On a paste not yet
 *              saved every image is held, listed in the popover and sent with the
 *              form that creates the paste unless it is removed first; a placed one
 *              waits as `pending-image:{key}`, which the server replaces with the
 *              image's address. An image over the limit, or a file
 *              that is no image the store keeps, is refused before anything is sent.
 *
 * @input Files; the upload and delete addresses and token; the editor's insert and replace
 * @output Snippets in the text; transfers, announced through onTransfer and onTransferChange;
 *         images waiting for their paste, announced through onHeld
 * @dependencies editor/image-transfer
 */

import { ImageTransfer, TRANSFER } from './image-transfer.js';

export const PENDING_PREFIX = 'pending-image:';
const UPLOADING_PREFIX = 'uploading:';
const PENDING_PATTERN = /pending-image:([a-z0-9]{8,40})/g;

/** The types the image store keeps (ImageProxyService::ALLOWED_MIME_TYPES). */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml', 'image/apng'];

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeAttribute = (text) => String(text).replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]);

export function isImageFile(file) {
    return Boolean(file) && IMAGE_TYPES.includes(String(file.type || '').toLowerCase());
}

/** Alt text from a file name: no extension, nothing that would break the markup around it. */
export function altTextFor(name) {
    const alt = String(name || '').replace(/\.[^.]*$/, '').replace(/[[\]()<>"`]/g, ' ').replace(/\s+/g, ' ').trim();
    return alt === '' ? 'image' : alt;
}

/** An image as a document of this type shows one. */
export function imageSnippet(type, url, alt) {
    if (type === 'html') return '<img src="' + escapeAttribute(url) + '" alt="' + escapeAttribute(alt) + '">';
    if (type === 'code') return String(url);
    return '![' + alt + '](' + url + ')';
}

/**
 * An image's address as a document on this site holds it, and as the images
 * popover inserts and copies it: the path alone when the address is this site's.
 */
export function sitePath(url, origin) {
    const value = String(url ?? '');
    return origin && value.startsWith(origin + '/') ? value.slice(origin.length) : value;
}

/** Twelve random base-36 characters. */
export function pendingKey() {
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('');
}

/** Each waiting image's placeholder as the address it became, or nothing. */
export function replacePending(text, addresses) {
    return String(text).replace(PENDING_PATTERN, (whole, key) => (Object.hasOwn(addresses, key) ? addresses[key] : ''));
}

function formatBytes(bytes) {
    return bytes >= 1048576 ? (Math.round(bytes / 104857.6) / 10) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

export class ImageUploads {
    constructor(options = {}) {
        this.pending = Boolean(options.pending);
        this.uploadUrl = options.uploadUrl || null;
        this.deleteUrl = options.deleteUrl || null;
        this.csrfToken = options.csrfToken || null;
        this.maxBytes = options.maxBytes > 0 ? options.maxBytes : Infinity;
        this.t = options.t || ((key) => key);
        this.editor = options.editor;
        this.typeOf = options.typeOf || (() => 'markdown');
        this.toast = options.toast || (() => {});
        this.onUploaded = options.onUploaded || (() => {});
        this.onHeld = options.onHeld || (() => {});
        this.onTransfer = options.onTransfer || (() => {});
        this.onTransferChange = options.onTransferChange || (() => {});
        this.fetch = options.fetch || ((...args) => globalThis.fetch(...args));
        this.transferUrl = options.transferUrl || (this.uploadUrl ? this.uploadUrl + '/uploads' : null);
        this.request = options.request || null;
        this.sleep = options.sleep || null;
        this.maxConcurrent = options.maxConcurrent || 2;
        this.pumping = false;
        /** key -> File, for a paste not yet saved */
        this.waiting = new Map();
        /** every image on its way to a saved paste, in the order it was chosen */
        this.transfers = [];
    }

    /** Files dropped or pasted onto the text: stored, and placed where the cursor is. */
    add(files) {
        return this.take(files, true);
    }

    /** Files chosen in the Images popover: stored, and placed nowhere until Insert is pressed. */
    upload(files) {
        return this.take(files, false);
    }

    /** Resolves once every upload has been answered. */
    take(files, place) {
        const work = [];
        for (const file of Array.from(files || [])) {
            if (!isImageFile(file)) {
                this.toast(this.t('image_refused_not_image', { name: file.name }), 'error');
                continue;
            }
            if (file.size > this.maxBytes) {
                this.toast(this.t('image_refused_too_large', { name: file.name, limit: formatBytes(this.maxBytes) }), 'error');
                continue;
            }
            work.push(this.pending ? this.hold(file, place) : this.send(file, place));
        }
        return Promise.all(work).then(() => undefined);
    }

    /** An image the paste already has, where the cursor is. */
    insertExisting(url, name) {
        this.editor.insert(imageSnippet(this.typeOf(), url, name ? altTextFor(name) : 'image'));
    }

    /**
     * Every image still held: what the form that creates the paste sends. One no
     * document shows is sent too, as an image uploaded to a saved paste stays
     * whether a document shows it or not; removing it from the popover is how it
     * is left out.
     */
    pendingFor() {
        return [...this.waiting].map(([key, file]) => ({ key, file }));
    }

    /** A held image, placed where the cursor is. False when there is no such image. */
    insertPending(key) {
        const file = this.waiting.get(key);
        if (!file) return false;
        this.editor.insert(imageSnippet(this.typeOf(), PENDING_PREFIX + key, altTextFor(file.name)));
        return true;
    }

    /** Stop holding an image, so the form does not send it. */
    discard(key) {
        return this.waiting.delete(key);
    }

    /** Delete an upload. True once the server has. */
    async remove(id) {
        if (!this.deleteUrl) return false;
        try {
            const response = await this.fetch(this.deleteUrl.replace('__ID__', encodeURIComponent(id)), {
                method: 'DELETE',
                headers: { 'X-CSRF-Token': this.csrfToken },
                credentials: 'same-origin',
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    hold(file, place) {
        const key = pendingKey();
        this.waiting.set(key, file);
        if (place) this.insertPending(key);
        this.onHeld({ key, file });
        return Promise.resolve();
    }

    /** Resolves when the image first stops: stored, refused, cancelled, paused or waiting to be resumed. */
    send(file, place) {
        // The type at the moment of dropping decides the snippet, whatever is shown by the time it lands.
        const type = this.typeOf();
        const alt = altTextFor(file.name);
        const placeholder = place ? imageSnippet(type, UPLOADING_PREFIX + pendingKey(), alt) : null;
        if (placeholder) this.editor.insert(placeholder);

        let stopped;
        const firstStop = new Promise((resolve) => { stopped = resolve; });
        const transfer = new ImageTransfer(file, {
            url: this.transferUrl,
            csrfToken: this.csrfToken,
            request: this.request || undefined,
            sleep: this.sleep || undefined,
            onChange: (moving) => {
                this.settle(moving, { type, alt, placeholder });
                if (!moving.moving) stopped();
            },
        });
        this.transfers.push(transfer);
        this.onTransfer(transfer);
        this.pump();

        return firstStop;
    }

    /** What an image's state means for the text and the gallery, the first time it arrives there. */
    settle(transfer, { type, alt, placeholder }) {
        if (transfer.over && !transfer.settled) {
            transfer.settled = true;
            // A refused image stays listed, to say why, until it is dismissed.
            if (transfer.state !== TRANSFER.REFUSED) this.transfers = this.transfers.filter((candidate) => candidate !== transfer);
            if (transfer.state === TRANSFER.DONE) {
                if (placeholder) this.editor.replace(placeholder, imageSnippet(type, transfer.image.url, alt));
                this.onUploaded(transfer.image);
            } else {
                if (placeholder) this.editor.replace(placeholder, '');
                if (transfer.state === TRANSFER.REFUSED) {
                    this.toast(transfer.error || this.t('image_refused_failed', { name: transfer.file.name }), 'error');
                }
            }
        }
        this.onTransferChange(transfer);
        this.pump();
    }

    /** Start waiting images, in order, while fewer than maxConcurrent are under way. */
    pump() {
        if (this.pumping) return;
        this.pumping = true;
        try {
            for (;;) {
                const underway = this.transfers.filter((transfer) => transfer.moving && transfer.state !== TRANSFER.WAITING).length;
                const next = this.transfers.find((transfer) => transfer.state === TRANSFER.WAITING);
                if (!next || underway >= this.maxConcurrent) break;
                next.start();
                // Starting leaves the waiting state at once; if it did not, stop rather than loop.
                if (next.state === TRANSFER.WAITING) break;
            }
        } finally {
            this.pumping = false;
        }
    }

    /** Pause, resume, cancel or dismiss an image in the upload list. */
    act(key, action) {
        const transfer = this.transfers.find((candidate) => candidate.key === key);
        if (!transfer) return false;
        if (action === 'pause') transfer.pause();
        else if (action === 'resume') transfer.resume();
        else if (action === 'cancel') transfer.cancel();
        else if (action === 'dismiss' && transfer.over) {
            this.transfers = this.transfers.filter((candidate) => candidate !== transfer);
        } else return false;
        return true;
    }

    /** Images not yet stored, cancelled or refused: what saving now would leave behind. */
    unfinished() {
        return this.transfers.filter((transfer) => !transfer.over);
    }

    /** Cancel every image still on its way; their places in the text are given back. */
    cancelAll() {
        for (const transfer of this.unfinished()) transfer.cancel();
    }
}
