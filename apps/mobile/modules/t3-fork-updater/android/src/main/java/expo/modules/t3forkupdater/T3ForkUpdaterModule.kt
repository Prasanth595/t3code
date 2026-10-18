package expo.modules.t3forkupdater

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Installs a downloaded fork APK over the running app with a PackageInstaller session. On
 * Android 12+ an update needs no tap once this app is the installer of record, which it becomes
 * after its first self-update. Until then Android shows its confirmation.
 */
class T3ForkUpdaterModule : Module() {
  private var foreground = true
  private var pendingConfirmation: Intent? = null

  override fun definition() = ModuleDefinition {
    Name("T3ForkUpdater")

    OnActivityEntersForeground {
      foreground = true
      showPendingConfirmation()
    }

    OnActivityEntersBackground { foreground = false }

    AsyncFunction("install") { fileUri: String, promise: Promise ->
      val context = appContext.reactContext?.applicationContext
      if (context == null) {
        promise.reject("ERR_NO_CONTEXT", "The app is not ready to install the update.", null)
        return@AsyncFunction
      }
      try {
        install(context, File(Uri.parse(fileUri).path ?: fileUri), promise)
      } catch (error: Exception) {
        promise.reject("ERR_INSTALL", error.message ?: "Could not install the update.", error)
      }
    }
  }

  private fun install(context: Context, apk: File, promise: Promise) {
    val installer = context.packageManager.packageInstaller
    val params =
      PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
        setAppPackageName(context.packageName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
      }
    val sessionId = installer.createSession(params)
    val action = "${context.packageName}.FORK_UPDATE_RESULT.$sessionId"
    val receiver =
      object : BroadcastReceiver() {
        override fun onReceive(receiverContext: Context, intent: Intent) {
          val status =
            intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
          if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)?.let {
              pendingConfirmation = it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
              if (foreground) showPendingConfirmation()
            }
            return
          }
          receiverContext.unregisterReceiver(this)
          // On success Android replaces the process, so this answer rarely arrives.
          if (status == PackageInstaller.STATUS_SUCCESS) {
            promise.resolve(null)
          } else {
            val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
            promise.reject("ERR_INSTALL_$status", message ?: "The update was not installed.", null)
          }
        }
      }
    ContextCompat.registerReceiver(
      context,
      receiver,
      IntentFilter(action),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    try {
      installer.openSession(sessionId).use { session ->
        apk.inputStream().use { input ->
          session.openWrite("base.apk", 0, apk.length()).use { output ->
            input.copyTo(output)
            session.fsync(output)
          }
        }
        // The installer fills in the status extras, so the intent must be mutable.
        val callback =
          PendingIntent.getBroadcast(
            context,
            sessionId,
            Intent(action).setPackage(context.packageName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
          )
        session.commit(callback.intentSender)
      }
    } catch (error: Exception) {
      context.unregisterReceiver(receiver)
      installer.abandonSession(sessionId)
      throw error
    }
  }

  /** Android blocks activity starts from the background, so a confirmation waits for the app. */
  private fun showPendingConfirmation() {
    val intent = pendingConfirmation ?: return
    val activity = appContext.currentActivity ?: return
    pendingConfirmation = null
    activity.startActivity(intent)
  }
}
