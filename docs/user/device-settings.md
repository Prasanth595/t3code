# Move device settings between browsers

Device settings, such as fonts, chat width, sidebar and composer behavior, confirmations, and your
theme, are saved separately on each browser and in the desktop app. To set up another browser the
same way, open **Settings → General**, choose **Export**, then choose **Import** on the other
browser and pick the file.

The file lists only the settings you changed from their defaults, plus any custom themes your
current theme uses. It leaves out settings that belong to one machine or one environment, such as
browser profiles and per-project overrides. Environment settings are not included either, since
the server keeps those in its own `settings.json`.

Import replaces your device settings. Before anything changes, it lists every setting it will
change, and any setting the file leaves out goes back to its default. A custom theme in the file
replaces a local one with the same ID. Values this version doesn't recognize are skipped and shown
as warnings, so a file from an older or newer version still applies everything it can.

The file is plain JSON, so you can keep it with your dotfiles and edit it by hand.
