// The bridge's own failures, each with the status a client sees: 400 a bad request, 401 no
// accepted key, 403 a route not allowed, 405 another method, 413 a body too large, 502 AnythingLLM
// can't be reached or refused the login.
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
export const notAllowed = (message: string): BridgeError => new BridgeError(405, message);
export const tooLarge = (message: string): BridgeError => new BridgeError(413, message);
export const upstream = (message: string): BridgeError => new BridgeError(502, message);
