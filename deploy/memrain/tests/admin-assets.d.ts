// The office tests pull admin files that import models with Vite's `?url`;
// the admin build has its own declaration, the root typecheck needs this one.
declare module "*?url" {
  const url: string;
  export default url;
}
