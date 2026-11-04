/**
 * Which requests an app answers itself, for toNodeHandler(app, { fallthrough: true }). Kept apart from
 * app.ts so the Node handler (and the framework entry points that use it) load no router code.
 */
const matchers = new WeakMap<object, (method: string, pathname: string) => boolean>();

/** Called by createApp with a function that knows the app's routes and built-in endpoints. */
export function registerRequestMatcher(app: object, matcher: (method: string, pathname: string) => boolean): void {
  matchers.set(app, matcher);
}

/** True when the app has a route or built-in endpoint for this method and path; undefined for objects that are not apps from createApp. */
export function appAnswers(app: object, method: string, pathname: string): boolean | undefined {
  return matchers.get(app)?.(method, pathname);
}
