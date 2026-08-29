// Latest stable Swift toolchain line (6.3.x, incl. 6.3.3).
// Toolchains are matched by prefix so 6.3.0 / 6.3.1 / 6.3.2 / 6.3.3 all qualify.
export const SWIFT_VERSION_PREFIX = "6.3";

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
