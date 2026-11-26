import type { ExtensionRequest, ExtensionResponse } from "../types.js";

export class MessageError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MessageError";
    this.code = code;
  }
}

/** Typed request/response wrapper around chrome.runtime.sendMessage. */
export async function sendMessage<T>(request: ExtensionRequest): Promise<T> {
  let response: ExtensionResponse<T> | undefined;
  try {
    response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse<T> | undefined;
  } catch (error) {
    throw new MessageError(
      "background_unavailable",
      error instanceof Error
        ? "The extension background is unavailable. Reload the extension and try again."
        : "The extension background did not respond.",
    );
  }
  if (!response) {
    throw new MessageError("no_response", "The extension background did not respond.");
  }
  if (!response.ok) throw new MessageError(response.error.code, response.error.message);
  return response.data;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}
