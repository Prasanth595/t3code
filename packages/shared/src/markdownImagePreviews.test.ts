import { expect, it } from "vite-plus/test";
import { appendMissingImagePreviews } from "./markdownImagePreviews.ts";

it.each([
  "![image](</tmp/generated image.png>)",
  "![image](/tmp/generated%20image.png)",
  "![image][result]\n\n[result]: </tmp/generated image.png>",
  "![result][]\n\n[result]: </tmp/generated image.png>",
  "![result]\n\n[result]: </tmp/generated image.png>",
  "![image](file:///tmp/generated%20image.png)",
])("preserves an existing rendered image: %s", (reply) => {
  expect(appendMissingImagePreviews(reply, ["/tmp/generated image.png"])).toBe(reply);
});

it.each([
  "Saved to /tmp/generated image.png",
  "[Open](</tmp/generated image.png>)",
  "`![image](</tmp/generated image.png>)`",
  "```markdown\n![image](</tmp/generated image.png>)\n```",
  "    ![image](</tmp/generated image.png>)",
  "\\![image](</tmp/generated image.png>)",
])("adds a preview when the path is not a rendered image: %s", (reply) => {
  expect(appendMissingImagePreviews(reply, ["/tmp/generated image.png"])).toBe(
    `${reply}\n\n![Generated image](</tmp/generated%20image.png>)`,
  );
});

it("recognizes Windows drive, separator, encoding and case variants", () => {
  const reply = "![image](file:///c:/Users/example/generated%20image.png)";
  expect(appendMissingImagePreviews(reply, ["C:\\Users\\EXAMPLE\\generated image.png"])).toBe(
    reply,
  );
});

it("escapes reserved path characters and does not append the same file twice", () => {
  const path = "/tmp/a<b>#?% image.png";
  const preview = "![Generated image](</tmp/a%3Cb%3E%23%3F%25%20image.png>)";
  expect(appendMissingImagePreviews("", [path, path])).toBe(preview);
  expect(appendMissingImagePreviews(preview, [path])).toBe(preview);
});

it("recognizes an existing escaped image destination", () => {
  const reply = "![image](</tmp/a\\<b\\>.png>)";
  expect(appendMissingImagePreviews(reply, ["/tmp/a<b>.png"])).toBe(reply);
});

it("does not equate distinct POSIX case or literal backslash filenames", () => {
  expect(appendMissingImagePreviews("![image](/tmp/image.png)", ["/tmp/Image.png"])).toContain(
    "![Generated image](</tmp/Image.png>)",
  );
  expect(appendMissingImagePreviews("![image](/tmp/a/b.png)", ["/tmp/a\\b.png"])).toContain(
    "![Generated image](</tmp/a%5Cb.png>)",
  );
});

it("preserves multiple unique images, including one already shown in an earlier final message", () => {
  expect(
    appendMissingImagePreviews(
      "Done.",
      ["/tmp/one.png", "/tmp/two.png", "/tmp/two.png"],
      ["![image](/tmp/one.png)"],
    ),
  ).toBe("Done.\n\n![Generated image](</tmp/two.png>)");
});
