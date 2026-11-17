/** A returned PDF starts with the %PDF- header and, for a real render, is more than a trivial stub. */
export function isPdf(body: Buffer): boolean {
  return body.length > 1024 && body.subarray(0, 5).toString("latin1") === "%PDF-";
}
