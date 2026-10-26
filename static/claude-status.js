// Persistent status belongs to the build that produced it, not every future build.
export function statusForVersion(status, version) {
  if (!status || status.version === version) return status;
  return {
    ok: null,
    message: `Updated to v${version}. Previous status is from an older version. Refresh YouTube Music to translate again.`,
  };
}

export function statusText(status) {
  if (!status) return "Not checked yet";
  return (status.ok === true ? "✓ " : status.ok === false ? "✕ " : "") + status.message;
}
