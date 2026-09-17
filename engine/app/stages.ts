// engine/app/stages.ts — the three model-judgment stages: screen, tailor, check.
// Each: build the prompt context → call the injected ModelGateway → validate the
// output shape (fail closed). Maker/checker separation is structural here:
// tailor and check are separate stages with separate calls, never merged.
import type { Config, HonestyResult, JobPosting, ProfileBundle, ScreenResult, TailorResult } from "../domain/types.ts";
import { parseHonesty, parseScreen, parseTailor } from "../domain/validate.ts";
import type { ModelGateway, PromptReader } from "../ports.ts";

export interface StageDeps {
  gateway: ModelGateway;
  prompts: PromptReader;
  cfg: Config;
}

function jdBlock(p: JobPosting): string {
  return `title: ${p.title}\ncompany: ${p.company}\nlocation: ${p.location ?? "n/a"}\nurl: ${p.url}\n\n${p.jd_text}`;
}

export async function screenPosting(d: StageDeps, p: JobPosting, positioning: string): Promise<ScreenResult> {
  const r = await d.gateway.call({
    model: d.cfg.llm.screen_model, system: d.prompts.read("screen.md"), temperature: 0.1, json: true,
    user: `<positioning>\n${positioning}\n</positioning>\n\n<posting>\n${jdBlock(p)}\n</posting>`,
  });
  return parseScreen(r.text);
}

export async function tailorResume(d: StageDeps, p: JobPosting, screen: ScreenResult, profile: ProfileBundle): Promise<TailorResult> {
  const r = await d.gateway.call({
    model: d.cfg.llm.work_model, system: d.prompts.read("tailor.md"), temperature: d.cfg.llm.temperature, json: true,
    user: `<master_resume>\n${profile.masterResume}\n</master_resume>\n\n<fact_vault>\n${profile.factVault}\n</fact_vault>\n\n<jd>\ntitle: ${p.title}\ncompany: ${p.company}\n\n${p.jd_text}\n</jd>\n\n<screen>\n${JSON.stringify(screen)}\n</screen>`,
  });
  return parseTailor(r.text);
}

export async function honestyCheck(d: StageDeps, tailoredYaml: string, profile: ProfileBundle): Promise<HonestyResult> {
  const r = await d.gateway.call({
    model: d.cfg.llm.work_model, system: d.prompts.read("check.md"), temperature: 0, json: true,
    user: `<tailored_resume>\n${tailoredYaml}\n</tailored_resume>\n\n<fact_vault>\n${profile.factVault}\n</fact_vault>\n\n<master_resume>\n${profile.masterResume}\n</master_resume>`,
  });
  return parseHonesty(r.text);
}
