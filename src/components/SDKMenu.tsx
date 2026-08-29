import { Button, Typography } from "@mui/joy";
import { useIDE } from "../utilities/IDEContext";
import { open } from "@tauri-apps/plugin-dialog";
import { useToast } from "react-toast-plus";
import { useCallback, useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { installSdkOperation } from "../utilities/operations";
import ErrorIcon from "@mui/icons-material/Error";
import WarningIcon from "@mui/icons-material/Warning";
import {
  XCODE_VERSION,
  isSupportedSDKVersion,
} from "../utilities/constants";

export default () => {
  const {
    selectedToolchain,
    hasDarwinSDK,
    darwinSDKVersion,
    checkSDK,
    startOperation,
    isWindows,
    hasWSL,
  } = useIDE();
  const { addToast } = useToast();

  const isWindowsReady = !isWindows || hasWSL;

  const install = useCallback(async () => {
    let xipPath = await open({
      directory: false,
      multiple: false,
      filters: [
        {
          name: "XCode",
          extensions: ["xip"],
        },
      ],
    });
    if (!xipPath) {
      addToast.error("No Xcode.xip selected");
      return;
    }
    const params = {
      xcodePath: xipPath,
      toolchainPath: selectedToolchain?.path || "",
      isDir: false,
    };
    await startOperation(installSdkOperation, params);
    checkSDK();
  }, [selectedToolchain, addToast]);

  const installFromFolder = useCallback(async () => {
    let xcodePath = await open({
      directory: true,
      multiple: false,
      filters: [
        {
          name: "XCode.app",
          extensions: ["app"],
        },
      ],
    });
    if (!xcodePath) {
      addToast.error("No Xcode selected");
      return;
    }
    const params = {
      xcodePath,
      toolchainPath: selectedToolchain?.path || "",
      isDir: true,
    };
    await startOperation(installSdkOperation, params);
    checkSDK();
  }, [selectedToolchain, addToast]);

  useEffect(() => {
    checkSDK();
  }, [checkSDK]);

  if (hasDarwinSDK === null) {
    return <div>Checking for SDK...</div>;
  }

  return (
    <div
      style={{
        width: "fit-content",
        display: "flex",
        flexDirection: "column",
        gap: "var(--padding-md)",
      }}
    >
      <div>
        <Typography
          level="body-md"
          color={
            hasDarwinSDK ? "success" : selectedToolchain ? "danger" : "warning"
          }
          sx={{
            alignContent: "center",
            display: "flex",
            gap: "var(--padding-xs)",
          }}
        >
          {isWindowsReady ? (
            hasDarwinSDK ? (
              "Darwin SDK is installed!"
            ) : (
              <>
                {selectedToolchain ? <ErrorIcon /> : <WarningIcon />}
                {selectedToolchain
                  ? "Darwin SDK is not installed"
                  : "Select a swift toolchain first"}
              </>
            )
          ) : (
            "Install WSL and Swift first."
          )}
        </Typography>
        {hasDarwinSDK && (
          <Typography
            level="body-sm"
            color={
              isSupportedSDKVersion(darwinSDKVersion) ? undefined : "warning"
            }
          >
            {isSupportedSDKVersion(darwinSDKVersion)
              ? `Version: ${darwinSDKVersion}`
              : `Unsupported SDK version (${darwinSDKVersion}). It is older than the minimum supported version (26.5). Please re-install with Xcode ${XCODE_VERSION} or later.`}
          </Typography>
        )}
      </div>
      <div
        style={{
          display: "flex",
          gap: "var(--padding-md)",
        }}
      >
        <Button
          variant="soft"
          onClick={(e) => {
            e.preventDefault();
            openUrl(
              "https://developer.apple.com/services-account/download?path=/Developer_Tools/Xcode_26/Xcode_26.6_Universal.xip"
            );
          }}
        >
          Download XCode {XCODE_VERSION}
        </Button>
        <Button
          variant="soft"
          onClick={(e) => {
            if (e.shiftKey) {
              installFromFolder();
            } else {
              install();
            }
          }}
          disabled={!selectedToolchain}
        >
          {hasDarwinSDK ? "Reinstall SDK" : "Install SDK"}
        </Button>
        <Button variant="soft" onClick={checkSDK} disabled={!selectedToolchain}>
          Check Again
        </Button>
      </div>
    </div>
  );
};
