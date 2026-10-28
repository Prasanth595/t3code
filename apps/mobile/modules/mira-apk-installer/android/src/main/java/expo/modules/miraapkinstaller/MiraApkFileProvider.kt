package expo.modules.miraapkinstaller

import androidx.core.content.FileProvider

// A subclass keeps this provider from colliding with other libraries' FileProvider entries.
class MiraApkFileProvider : FileProvider()
