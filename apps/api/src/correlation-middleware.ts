/**
 * Where a request's correlation begins.
 *
 * Express middleware rather than a Nest interceptor or guard, and the ordering
 * is the whole point: Nest runs middleware before guards, and the guard writes
 * audit rows for the refusals it makes. An interceptor would establish the
 * context after those rows were already written, so exactly the requests that
 * were refused — the ones an investigation is most likely to start from — would
 * be the ones with no correlation.
 *
 * Everything downstream reads the context ambiently through `AsyncLocalStorage`,
 * so nothing else in the request path has to carry it or remember it exists.
 */

import type { NextFunction, Request, Response } from "express";

import {
  acceptExternalCorrelation,
  newCorrelation,
  runWithCorrelation,
} from "@aios/application";

/** What a caller may offer. Retained as untrusted metadata, never promoted. */
const EXTERNAL_HEADER = "x-external-correlation-id";

/** What the server returns. Always its own value. */
const RESPONSE_HEADER = "x-correlation-id";

export const correlationMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  const context = newCorrelation(
    // Validated and bounded before it is kept at all: this value reaches logs,
    // so an unbounded one is a way to flood a sink and one with newlines is a
    // way to forge records.
    acceptExternalCorrelation(request.header(EXTERNAL_HEADER)),
  );

  // "Public API responses return the server-owned `correlationId`, not the
  // caller-supplied value." Set before the handler runs so it survives an error
  // response too — a failed request is the one whose identifier a caller most
  // needs in order to report it.
  response.setHeader(RESPONSE_HEADER, context.correlationId);

  runWithCorrelation(context, () => next());
};
