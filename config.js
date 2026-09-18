// Written by `npm run setup`. Safe to commit: the VAPID public key is meant to
// be public, `repo` only names the private data repo, and the token that
// authorizes reads and writes lives in each browser's localStorage.
window.CLEANIT_CONFIG = {
  repo: "tiageri/cleanit-data",
  branch: "main",
  dataPath: "state.json",
  subsPath: "subscriptions.json",
  vapidPublicKey: "BNgtciUd5wWhV1ykdI2etuLoVBtvS_l5FunvMlsdOdVguLGglr1wlfLGi4_JxenEyvWgBnfMfeRKFzV5ABQvXcE",
};
