# Desktop data home

Finder and Dock launches can select an existing T3 home without modifying the
signed app. Selection happens synchronously before desktop settings, Clerk
storage, or the local backend starts, in this order:

1. A nonempty `T3CODE_HOME` environment variable (existing behavior).
2. `~/.nofun-t3-desktop.json` in the current account's home directory.
3. The unchanged default `~/.nofun-t3` when the selector is absent.

The selector contains exactly one field. Use the absolute path to the **base
T3 home**, whose `userdata` directory contains the existing desktop settings
and database. For example, substituting your own account and existing path:

```json
{ "t3Home": "/Users/your-account/existing-t3-home" }
```

Create the file privately with mode `600` (or read-only `400`), owned by the
current user. It must be a regular file without symlinks or hard links and no
larger than 4096 bytes. The selected directory must already exist and belong
to the current user. Neither its path nor the selector's parent path may
contain symlinks, group/other-writable directories, or directories owned by
someone other than the current user or root. Do not use `~`, `.` or `..` path
segments. Directory read/search permissions for others are allowed; directory
write access for others is not. These ownership checks support macOS/Linux;
on Windows use the existing `T3CODE_HOME` environment override.

An unreadable, malformed, oversized, or unsafe selector stops startup with a
clear error before any desktop settings or database opens. It never silently
opens the default home instead. A nonempty environment override takes
precedence even if a selector is invalid. To restore default selection, quit
the app and remove the selector; to change identity, quit and replace the
selector with another valid existing home. Restart through Finder or Dock.
The app does not create, migrate, copy, or merge data or credentials as part
of home selection. The selector stays outside the app and survives updates;
the same app bytes work on machines with different homes or no selector.

## Release version

`node scripts/build-desktop-artifact.ts --build-version <version>` supplies
`APP_VERSION` to the desktop/server/web build before packaging. The web build
embeds it as `import.meta.env.APP_VERSION`; the server pack loader supplies it
to every import of the server package manifest. The desktop reads the same
version from the packaged app metadata. Tracked package manifests are unchanged.
`--skip-build` with a custom version (including `T3CODE_DESKTOP_VERSION`) is
rejected because prebuilt output has no verified version receipt. Rebuild
without that flag; changing only bundle metadata cannot update compiled code.
