# Use T3 Code as your default browser

On macOS, the desktop app can be your default web browser. Links you open from other apps then
open in T3 Code. When the thread on screen shows its browser panel, the link opens there as a new
tab. Otherwise it starts a new thread without a project, with the browser panel maximized on the
page, so you can ask an agent about it right away.

Choose **T3 Code** under **System Settings → Desktop & Dock → Default web browser**. To go back,
choose another browser there.

HTML files you open from Finder open the same way.

A link that launches T3 Code waits until the app has connected to its environment, then opens.

## Open pull and merge request links

On macOS desktop, **Settings → Integrations → Browser → Open PR and MR links in T3 Code**
can route pull and merge request links from other apps to T3 Code's PR or MR panel. This is off
by default. Choose an installed browser for other links, turn the setting on, then use
**Open System Settings** to choose T3 Code as your default web browser. T3 Code never changes
your system default automatically.

This supports GitHub, GitLab, Forgejo, Gitea, and other supported source control hosts, including
self-hosted projects. Add the repository as a project and connect its environment with the
source control credentials it needs. Links without a matching project open in your chosen browser,
as do other web links.

To undo the setup, turn the setting off and choose your browser again under
**System Settings → Desktop & Dock → Default web browser**. Your browser choice is kept for
the next time you enable routing. Turning this setting off alone keeps the normal T3 Code
default-browser behavior described above until you change the system default.
