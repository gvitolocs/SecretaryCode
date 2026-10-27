/** Preserve the hosted CSP, adding only the token-gated local image transport. */
export function localImagePolicy(policy: string) {
  const directives = policy
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .filter((parts) => parts[0])
  const defaults = directives.find((parts) => parts[0] === "default-src")?.slice(1) ?? []
  for (const name of ["img-src", "connect-src"]) {
    const directive = directives.find((parts) => parts[0] === name)
    if (directive) {
      if (!directive.includes("secretary-file:")) directive.push("secretary-file:")
      continue
    }
    directives.push([name, ...defaults, "secretary-file:"])
  }
  return directives.map((parts) => parts.join(" ")).join("; ")
}
