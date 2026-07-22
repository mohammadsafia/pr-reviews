/** Common base for PR-host auth failures (401/403). `app.ts` maps any instance of this to a
 * 401 response, regardless of which provider threw it. */
export class PrAuthError extends Error {}
