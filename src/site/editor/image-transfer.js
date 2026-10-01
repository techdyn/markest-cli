/**
 * @module editor/image-transfer
 * @description One image on its way to a saved paste, sent in pieces
 *              (D-20260917-02). It opens a session, sends each piece at the
 *              offset the server holds - reporting progress within a piece as
 *              well as between them - and ends as the stored image. Paused, it
 *              stops; resumed, it asks the server where it is and carries on from
 *              there. A lost connection is retried on its own with a growing wait
 *              and, after that, waits to be resumed. When the server asks to
 *              wait (429, 503) it waits as long as asked. A session that has gone
 *              is started again once. Cancelled, it tells the server. A refused
 *              image says why and is not tried again.
 *              `describeTransfer` says, for any state, what the upload list
 *              shows and which buttons it offers.
 *
 * @input A File; `{ url, csrfToken, request, sleep, retries, onChange }` -
 *        `request({method, url, headers, body, signal, onProgress})` resolving
 *        `{status, json, header(name)}`, XMLHttpRequest by default
 * @output Transfer state for the upload list; the stored image
 * @dependencies None
 */

export const TRANSFER = Object.freeze({
    WAITING: 'waiting',
    SENDING: 'sending',
    RETRYING: 'retrying',
    HELD: 'held',
    PAUSED: 'paused',
    FAILED: 'failed',
    REFUSED: 'refused',
    CANCELLED: 'cancelled',
    DONE: 'done',
});

const MOVING = new Set([TRANSFER.WAITING, TRANSFER.SENDING, TRANSFER.RETRYING, TRANSFER.HELD]);
const OVER = new Set([TRANSFER.REFUSED, TRANSFER.CANCELLED, TRANSFER.DONE]);

const WAIT_DEFAULT_MS = 5000;
const WAIT_MAX_MS = 60000;
const BACKOFF_MAX_MS = 8000;

let sequence = 0;

export class ImageTransfer {
    constructor(file, options = {}) {
        this.file = file;
        this.key = 'transfer-' + (++sequence);
        this.url = options.url;
        this.csrfToken = options.csrfToken || null;
        this.request = options.request || xhrRequest;
        this.sleep = options.sleep || wait;
        this.retries = options.retries ?? 3;
        this.onChange = options.onChange || (() => {});

        this.size = file.size;
        this.id = null;
        this.chunkBytes = 0;
        /** bytes the server has confirmed */
        this.received = 0;
        /** bytes of the piece in flight that have left */
        this.sending = 0;
        this.state = TRANSFER.WAITING;
        this.error = null;
        this.reason = null;
        this.image = null;
        this.restarted = false;
        this.controller = null;
        this.running = null;
    }

    get progress() {
        return this.size > 0 ? Math.min(1, (this.received + this.sending) / this.size) : 0;
    }

    /** Waiting, sending, or about to try again. */
    get moving() {
        return MOVING.has(this.state);
    }

    /** Stored, cancelled or refused: nothing more will happen. */
    get over() {
        return OVER.has(this.state);
    }

    /** Begin, or carry on after a pause or a failure. Resolves when the transfer stops, for whatever reason. */
    start() {
        if (this.over) return Promise.resolve(this);
        if (this.running) {
            if (this.moving) return this.running;
            // Stopped a moment ago, and the run it cut off has not yet ended: carry on
            // once it has, unless it is stopped again meanwhile.
            this.set(TRANSFER.WAITING);
            return this.running.then(() => (this.state === TRANSFER.WAITING ? this.start() : this));
        }
        this.running = this.run().finally(() => { this.running = null; });
        return this.running;
    }

    resume() {
        return this.start();
    }

    pause() {
        if (!this.moving) return;
        // The piece in flight is cut off: only what the server confirmed counts.
        this.sending = 0;
        this.set(TRANSFER.PAUSED);
        this.abort();
    }

    async cancel() {
        if (this.over) return;
        const id = this.id;
        this.sending = 0;
        this.set(TRANSFER.CANCELLED);
        this.abort();
        if (id === null) return;
        try {
            await this.request({ method: 'DELETE', url: this.sessionUrl(id), headers: this.headers() });
        } catch {
            // A session nobody finishes is swept away by the server within a day.
        }
    }

    set(state, extra = {}) {
        this.state = state;
        Object.assign(this, extra);
        this.onChange(this);
    }

    abort() {
        if (this.controller) this.controller.abort();
    }

    headers(extra = {}) {
        return Object.assign({ 'X-CSRF-Token': this.csrfToken, Accept: 'application/json' }, extra);
    }

    sessionUrl(id) {
        return this.url + '/' + encodeURIComponent(id);
    }

    async run() {
        const controller = new AbortController();
        this.controller = controller;
        const { signal } = controller;
        let failures = 0;
        // Carrying on: the server may hold more than was confirmed before the stop.
        let ask = this.id !== null;
        this.set(TRANSFER.SENDING);

        try {
            while (!signal.aborted) {
                let answer;
                const before = this.received;
                try {
                    if (this.id === null) answer = await this.open(signal);
                    else if (ask) answer = await this.where(signal);
                    else answer = await this.send(signal);
                    // A server error is a lost connection by another name.
                    if (answer.status >= 500 && answer.status !== 503) throw new Error('server ' + answer.status);
                } catch (error) {
                    this.sending = 0;
                    if (signal.aborted) break;
                    failures += 1;
                    if (failures > this.retries) {
                        this.set(TRANSFER.FAILED);
                        break;
                    }
                    this.set(TRANSFER.RETRYING);
                    await this.sleep(Math.min(BACKOFF_MAX_MS, 1000 * 2 ** (failures - 1)), signal);
                    ask = this.id !== null;
                    if (!signal.aborted) this.set(TRANSFER.SENDING);
                    continue;
                }
                this.sending = 0;
                if (signal.aborted) break;
                const { status } = answer;
                const json = answer.json || {};

                if (status === 429 || status === 503) {
                    this.set(TRANSFER.HELD);
                    await this.sleep(retryAfter(answer), signal);
                    if (!signal.aborted) this.set(TRANSFER.SENDING);
                    continue;
                }
                if (status === 201 && json.image) {
                    this.set(TRANSFER.DONE, { received: this.size, image: json.image });
                    break;
                }
                if (status === 201 && json.id) {
                    this.set(TRANSFER.SENDING, { id: json.id, received: json.received || 0, chunkBytes: json.chunkBytes });
                    continue;
                }
                if (status === 200 || status === 409) {
                    ask = false;
                    this.received = Number(json.received) || 0;
                    if (this.received > before) failures = 0;
                    this.set(TRANSFER.SENDING);
                    continue;
                }
                if (status === 404 && this.id !== null) {
                    if (this.restarted) {
                        this.set(TRANSFER.FAILED);
                        break;
                    }
                    // The session has gone - swept, or lost with a deploy: start the image again.
                    this.restarted = true;
                    ask = false;
                    this.set(TRANSFER.SENDING, { id: null, received: 0 });
                    continue;
                }
                if (status === 413 && json.reason === 'piece_too_large' && json.chunkBytes > 0) {
                    this.chunkBytes = json.chunkBytes;
                    this.received = Number(json.received) || 0;
                    continue;
                }
                this.set(TRANSFER.REFUSED, { error: json.error || null, reason: json.reason || null });
                break;
            }
        } finally {
            if (this.controller === controller) this.controller = null;
        }

        return this;
    }

    open(signal) {
        return this.request({
            method: 'POST',
            url: this.url,
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name: this.file.name, size: this.size, type: this.file.type }),
            signal,
        });
    }

    where(signal) {
        return this.request({ method: 'GET', url: this.sessionUrl(this.id), headers: this.headers(), signal });
    }

    send(signal) {
        const start = this.received;
        const end = Math.min(this.size, start + this.chunkBytes);
        return this.request({
            method: 'POST',
            url: this.sessionUrl(this.id),
            headers: this.headers({ 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(start) }),
            body: this.file.slice(start, end),
            signal,
            onProgress: (loaded) => {
                if (signal.aborted) return;
                this.sending = Math.max(0, Math.min(loaded, end - start));
                this.onChange(this);
            },
        });
    }
}

/**
 * What the upload list shows for a transfer: its name, a line saying where it
 * is, how far along it is, and which of pause, resume, cancel and dismiss it
 * offers.
 */
export function describeTransfer(transfer, t, formatSize) {
    // Rounded down, so nothing says 100% before the image is stored.
    const percent = Math.floor(transfer.progress * 100);
    const sizes = () => ({ done: formatSize(transfer.received + (transfer.sending || 0)), total: formatSize(transfer.size) });
    const name = transfer.file.name;

    switch (transfer.state) {
        case TRANSFER.WAITING:
            return { name, status: t('transfer_waiting'), percent, actions: ['cancel'] };
        case TRANSFER.SENDING:
            return { name, status: t('transfer_progress', sizes()) + ' · ' + percent + '%', percent, actions: ['pause', 'cancel'] };
        case TRANSFER.RETRYING:
            return { name, status: t('transfer_retrying'), percent, actions: ['pause', 'cancel'] };
        case TRANSFER.HELD:
            return { name, status: t('transfer_held'), percent, actions: ['pause', 'cancel'] };
        case TRANSFER.PAUSED:
            return { name, status: t('transfer_paused', sizes()), percent, actions: ['resume', 'cancel'] };
        case TRANSFER.FAILED:
            return { name, status: t('transfer_failed', sizes()), percent, actions: ['resume', 'cancel'] };
        case TRANSFER.REFUSED:
            return { name, status: transfer.error || t('image_refused_failed', { name }), percent, actions: ['dismiss'] };
        case TRANSFER.DONE:
            return { name, status: t('transfer_done'), percent: 100, actions: [] };
        default:
            return { name, status: '', percent, actions: [] };
    }
}

/** How long the server asked to be left alone, within bounds. */
function retryAfter(answer) {
    return retryAfterMs(typeof answer.header === 'function' ? answer.header('Retry-After') : NaN);
}

/**
 * A Retry-After value in seconds as a wait in milliseconds: 5 s when it says
 * nothing usable, never under a second or over a minute. The publishing
 * command waits the same way (cli/src/core/api-client).
 */
export function retryAfterMs(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return WAIT_DEFAULT_MS;
    return Math.min(WAIT_MAX_MS, Math.max(1000, seconds * 1000));
}

/** A wait that ends early when the transfer is paused or cancelled. */
function wait(ms, signal) {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        if (signal) signal.addEventListener('abort', done, { once: true });
    });
}

/** The browser's request, through XMLHttpRequest: fetch cannot report how much of a body has left. */
export function xhrRequest({ method, url, headers = {}, body = null, signal = null, onProgress = null }) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, url);
        for (const [name, value] of Object.entries(headers)) {
            if (value !== null && value !== undefined) xhr.setRequestHeader(name, value);
        }
        if (onProgress && xhr.upload) {
            xhr.upload.addEventListener('progress', (event) => onProgress(event.loaded));
        }
        xhr.addEventListener('load', () => {
            let json = {};
            try {
                json = xhr.responseText ? JSON.parse(xhr.responseText) : {};
            } catch {
                json = {};
            }
            resolve({ status: xhr.status, json, header: (name) => xhr.getResponseHeader(name) });
        });
        xhr.addEventListener('error', () => reject(new TypeError('The connection was lost.')));
        xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        if (signal) {
            if (signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            signal.addEventListener('abort', () => xhr.abort(), { once: true });
        }
        xhr.send(body);
    });
}
