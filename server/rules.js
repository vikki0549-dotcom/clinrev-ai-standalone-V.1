// Server-side access rules, mirroring what the page declared to the Claude
// runtime. Levels: view < interact < admin. Everything not listed is denied.
//
//   roles, settings, invites, creds   read: view      write: admin
//   members (collection, others' docs) read: admin     write: admin
//   members/{self}                     read: view      write: interact
//   encounters                         read: view      write: interact
//   data/users/{uid}/...               only uid == caller ("me" resolves to caller)
export const LEVEL = { none: 0, view: 1, interact: 2, admin: 3 };

const TOP = {
  roles: { read: "view", write: "admin" },
  settings: { read: "view", write: "admin" },
  invites: { read: "view", write: "admin" },
  creds: { read: "view", write: "admin" },
  encounters: { read: "view", write: "interact" },
  members: { read: "admin", write: "admin" },
};

// Replaces a "me" segment in the uid position of data/users/{uid}/... .
export function resolveMe(path, user) {
  const s = path.split("/");
  if (s[0] === "data" && s[1] === "users" && s[2] === "me") s[2] = user.id;
  return s.join("/");
}

// segs: validated path segments; isDoc: whether the path is a document;
// op: "read" | "write". Returns true when allowed.
export function allowed(user, segs, isDoc, op) {
  const lvl = LEVEL[user.level] || 0;
  if (!lvl) return false;
  const [top] = segs;

  if (top === "data") {
    // data/users/{uid}[/...]: private per-user area
    return segs.length >= 3 && segs[1] === "users" && segs[2] === user.id;
  }
  const rule = TOP[top];
  if (!rule) return false;
  // Only flat collections: "<top>" or "<top>/<id>"
  if (segs.length > 2) return false;
  if (top === "members" && isDoc && segs[1] === user.id) {
    return lvl >= LEVEL[op === "read" ? "view" : "interact"];
  }
  return lvl >= LEVEL[rule[op]];
}
