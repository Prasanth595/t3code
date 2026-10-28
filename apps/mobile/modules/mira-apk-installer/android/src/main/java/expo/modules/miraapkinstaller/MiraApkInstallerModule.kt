package expo.modules.miraapkinstaller

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class MiraApkInstallerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MiraApkInstaller")

    Function("canInstall") {
      val context = appContext.reactContext ?: return@Function false
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()
    }

    Function("openInstallPermissionSettings") {
      val context = appContext.reactContext ?: return@Function null
      context.startActivity(
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }

    // The APK must sit in the cache's mira-updates folder, the only path the provider shares.
    Function("install") { fileUri: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("No Android context")
      val file = File(Uri.parse(fileUri).path ?: fileUri)
      val contentUri = FileProvider.getUriForFile(context, "${context.packageName}.mira.apkinstaller", file)
      context.startActivity(
        Intent(Intent.ACTION_VIEW)
          .setDataAndType(contentUri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }
  }
}
