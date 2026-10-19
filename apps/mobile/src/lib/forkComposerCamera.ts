import type * as ImagePicker from "expo-image-picker";

let cameraRequested = false;

/**
 * Fork: runs a composer media handler so that its `pickComposerMedia` call takes a photo with
 * the camera instead of opening the photo library. Every composer handler (thread composer, new
 * thread draft, question answers) calls `pickComposerMedia` before its first `await`, so the
 * request is still set when the picker reads it. The handlers stay as upstream wrote them.
 */
export function takePhotoWith(pickMedia: () => Promise<void>): Promise<void> {
  cameraRequested = true;
  try {
    return pickMedia();
  } finally {
    cameraRequested = false;
  }
}

/** True once for a `pickComposerMedia` call that `takePhotoWith` started. */
export function consumeCameraRequest(): boolean {
  const requested = cameraRequested;
  cameraRequested = false;
  return requested;
}

/**
 * `imagePicker` with its library launcher replaced by one photo from the camera, so the upstream
 * picker code runs unchanged. Photos only, because the app asks for no microphone access. A
 * refused permission throws, so the picker shows it like any other picker error.
 */
export function withCameraLauncher<
  Picker extends Pick<
    typeof ImagePicker,
    "launchImageLibraryAsync" | "launchCameraAsync" | "requestCameraPermissionsAsync"
  >,
>(imagePicker: Picker): Picker {
  return {
    ...imagePicker,
    launchImageLibraryAsync: async () => {
      const permission = await imagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        throw new Error("Camera access is off. Turn it on in the system settings of T3 Code.");
      }
      return imagePicker.launchCameraAsync({ mediaTypes: ["images"], base64: false, quality: 1 });
    },
  };
}
