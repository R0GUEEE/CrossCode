import { createContext, useCallback } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import * as dialog from "@tauri-apps/plugin-dialog";
import { useToast } from "react-toast-plus";

export interface UpdateContextType {
  checkForUpdates: () => Promise<void>;
}

export const UpdateContext = createContext<UpdateContextType>({
  checkForUpdates: async () => {},
});

export const UpdateProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { addToast } = useToast();

  const checkForUpdates = useCallback(async () => {
    try {
      const update = await check();
      if (!update) return;

    let shouldUpdate = await dialog.ask(
      "A new update (" +
        (await getVersion()) +
        " -> " +
        update.version +
        ") is available. Would you like to install it?",
      {
        title: "Update Available",
      }
    );

    if (!shouldUpdate) return;

    let downloadPromise = update.download();

    addToast.promise(downloadPromise, {
      pending: "Downloading update...",
      success: "Update downloaded",
      error: "Failed to download update",
    });

    await downloadPromise;

    let installPromise = update.install();
    addToast.promise(installPromise, {
      pending: "Installing update...",
      success: "Update installed",
      error: "Failed to install update",
    });
    await installPromise;

    const shouldRelaunch = await dialog.ask(
      "The update has been installed. Would you like to relaunch the application?",
      {
        title: "Relaunch Required",
      }
    );

      if (shouldRelaunch) {
        await relaunch();
      }
    } catch (error) {
      console.error("Update failed:", error);
      addToast.error(
        error instanceof Error ? error.message : "Failed to check for or install updates"
      );
    }
  }, [addToast]);

  return (
    <UpdateContext.Provider value={{ checkForUpdates }}>
      {children}
    </UpdateContext.Provider>
  );
};
