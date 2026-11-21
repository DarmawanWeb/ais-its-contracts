import type { Principal } from './principal.js';

const principals = new WeakMap<object, Principal>();

/** Attaches the authenticated principal to a request (done by the auth guard). */
export function setRequestPrincipal(
  request: object,
  principal: Principal,
): void {
  principals.set(request, principal);
}

/** The authenticated principal of a request, if any. */
export function getRequestPrincipal(request: object): Principal | undefined {
  return principals.get(request);
}
