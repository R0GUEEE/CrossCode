// Supported Swift toolchain lines. 6.4.x is the latest stable line (Swift 6.4.0
// ships with the latest stable Xcode 27.0); 6.5 is included to support the
// in-development main-branch snapshots. Toolchains are matched by prefix, so
// e.g. 6.4.0 / 6.4.1 qualify for "6.4", and the 6.5 dev snapshots — including
// the "6.5-dev" string reported by `swift --version` — qualify for "6.5".
export const SWIFT_VERSION_PREFIXES = ["6.4", "6.5"];

// Recommended Swift version shown in the "swiftly install ..." hint and other
// onboarding copy. Stays on the latest STABLE line so beta toolchains
// are opt-in rather than the default advice.
export const SWIFT_VERSION_PREFIX = "6.4";

// The in-development toolchain line, offered as the "next release" option.
export const SWIFT_VERSION_SNAPSHOT_PREFIX = SWIFT_VERSION_PREFIXES[1];

// True when the given Swift version string belongs to a supported line.
// Handles stable versions ("6.4.0"), purely-numeric dev snapshots
// ("6.5.0.33.1"), the "6.5-dev" string from `swift --version`, and swiftly's
// snapshot directory naming ("swift-6.4.x-DEVELOPMENT-SNAPSHOT-...").
export function isSupportedSwiftVersion(version: string): boolean {
  return SWIFT_VERSION_PREFIXES.some((prefix) => {
    return version.startsWith(prefix) || version.includes(`swift-${prefix}`);
  });
}

// Minimum Darwin SDK version this build of CrossCode is tested/supported with.
// iOS SDK 27.0 ships with the latest stable Xcode 27.0. The app deliberately
// accepts ANY SDK >= this value so newer Xcode betas (27.1, 27.2, ...) do not
// get falsely flagged as unsupported.
export const MIN_DARWIN_SDK_VERSION = "27.0";

// Latest stable Xcode for the Download link + install guidance.
export const XCODE_VERSION = "27.0";

// Download link for the Xcode above. Apple names the .0 releases after the
// major version only ("Xcode_27/Xcode_27.xip") and everything else after the
// full version plus a "_Universal" suffix
// ("Xcode_26.6/Xcode_26.6_Universal.xip"), so derive it the same way.
const XCODE_MAJOR_VERSION = XCODE_VERSION.split(".")[0];
const XCODE_IS_MAJOR_RELEASE = XCODE_VERSION.endsWith(".0");
const XCODE_DIRECTORY = XCODE_IS_MAJOR_RELEASE
  ? `Xcode_${XCODE_MAJOR_VERSION}`
  : `Xcode_${XCODE_VERSION}`;
const XCODE_FILE = XCODE_IS_MAJOR_RELEASE
  ? XCODE_DIRECTORY
  : `${XCODE_DIRECTORY}_Universal`;

export const XCODE_DOWNLOAD_URL = `https://developer.apple.com/services-account/download?path=/Developer_Tools/${XCODE_DIRECTORY}/${XCODE_FILE}.xip`;

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
