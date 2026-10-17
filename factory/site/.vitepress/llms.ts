import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

interface Page {
  readonly text?: string;
  readonly link?: string;
}

interface Section {
  readonly title: string;
  readonly links: ReadonlyArray<Page>;
}

interface LlmsInput {
  readonly title: string;
  readonly siteUrl: string;
  readonly srcDir: string;
  readonly outDir: string;
  readonly sections: ReadonlyArray<Section>;
}

const sourceFile = (srcDir: string, link: string) =>
  NodePath.join(srcDir, link.endsWith("/") ? `${link}index.md` : `${link}.md`);

const withoutFrontmatter = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/u, "");

/**
 * Writes `llms.txt` (the title, then one line per page with its URL) and `llms-full.txt` (every
 * page's markdown, in the same order) to the site root. Called from the config's `buildEnd`, so
 * the pages are the sidebar's, plus the home page first.
 */
export const writeLlmsFiles = async ({ title, siteUrl, srcDir, outDir, sections }: LlmsInput) => {
  const index = [`# ${title}`, "", `- [Home](${siteUrl}/)`];
  const full: Array<string> = [];

  const addPage = async (link: string) => {
    const url = `${siteUrl}${link}`;
    const text = await NodeFSP.readFile(sourceFile(srcDir, link), "utf8");
    full.push(`${withoutFrontmatter(text).trim()}\n\nSource: ${url}`);
    return url;
  };

  await addPage("/");
  for (const section of sections) {
    index.push("", `## ${section.title}`, "");
    for (const page of section.links) {
      if (page.link === undefined) continue;
      const url = await addPage(page.link);
      index.push(`- [${page.text ?? page.link}](${url})`);
    }
  }

  await NodeFSP.writeFile(NodePath.join(outDir, "llms.txt"), `${index.join("\n")}\n`);
  await NodeFSP.writeFile(NodePath.join(outDir, "llms-full.txt"), `${full.join("\n\n")}\n`);
};
