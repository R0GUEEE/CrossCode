// Supported Swift toolchain lines. 6.3.x is the latest stable line
// (incl. 6.3.3); 6.4 is included to support the in-development Swift 6.4 /
// Xcode 27.0 snapshots. Toolchains are matched by prefix, so e.g. 6.3.0 /
// 6.3.1 / 6.3.2 / 6.3.3 qualify for "6.3", and the 6.4.x / 6.4 dev snapshots
// qualify for "6.4".
export const SWIFT_VERSION_PREFIXES = ["6.3", "6.4"];

// Recommended Swift version shown in the "swiftly install ..." hint and other
// onboarding copy. Stays on the latest STABLE line (6.3) so beta toolchains
// are opt-in rather than the default advice.
export const SWIFT_VERSION_PREFIX = "6.3";

// True when the given Swift version string belongs to a supported line.
// Handles stable versions ("6.3.3"), purely-numeric dev snapshots
// ("6.4.0.33.1"), and swiftly's snapshot directory naming
// ("swift-6.4-DEVELOPMENT-SNAPSHOT-...", plus the parsed <token> line from
// `swift --version`).
export function isSupportedSwiftVersion(version: string): boolean {
  return SWIFT_VERSION_PREFIXES.some((prefix) => {
    return (
      version.startsWith(prefix) || version.includes(`swift-${prefix}`)
    );
  });
}

// Minimum Darwin SDK version this build of CrossCode is tested/supported with.
// iOS SDK 26.5 ships with the latest stable Xcode 26.6. The app deliberately
// accepts ANY SDK >= this value so newer Xcode betas / releases (27.0, ...)
// do not get falsely flagged as unsupported.
export const MIN_DARWIN_SDK_VERSION = "26.5";

// Latest stable Xcode for the Download link + install guidance.
export const XCODE_VERSION = "26.6";

// True when the installed Darwin SDK is at or above the minimum supported.
// i.e. an SDK is "supported" unless it is older than MIN_DARWIN_SDK_VERSION.
export function isSupportedSDKVersion(installed: string): boolean {
  const minParts = MIN_DARWIN_SDK_VERSION.split(".").map(Number);
  const instParts = installed.split(".").map(Number);
  for (let i = 0; i < Math.max(minParts.length, instParts.length); i++) {
    const a = minParts[i] ?? 0;
    const b = instParts[i] ?? 0;
    if (b > a) return true;
    if (b < a) return false;
  }
  // Installed == minimum
  return true;
}
