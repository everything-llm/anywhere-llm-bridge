// The bridge's own failures, each with the status a client sees: 400 a bad request, 401 no
// accepted key, 403 a route not allowed (or a key that may not decide asks), 404 an ask or a host
// that isn't there, 405 another method, 409 an ask already decided or expired, 413 a body too
// large, 502 AnythingLLM can't be reached or refused the login, 503 a file held by another writer.
// The text is shown to the caller, who is a client or the person at the terminal.

export class BridgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const invalid = (message: string): BridgeError => new BridgeError(400, message);
export const unauthorized = (message: string): BridgeError => new BridgeError(401, message);
export const forbidden = (message: string): BridgeError => new BridgeError(403, message);
export const notFound = (message: string): BridgeError => new BridgeError(404, message);
export const notAllowed = (message: string): BridgeError => new BridgeError(405, message);
export const conflict = (message: string): BridgeError => new BridgeError(409, message);
export const tooLarge = (message: string): BridgeError => new BridgeError(413, message);
export const upstream = (message: string): BridgeError => new BridgeError(502, message);
export const busy = (message: string): BridgeError => new BridgeError(503, message);
