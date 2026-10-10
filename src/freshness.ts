/** A bounded state mismatch is retriable scan work, not a failed financial transaction. */
export class StaleCandidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleCandidateError";
  }
}
