import { cleanupArchive } from "../archive/cleanup.ts";
import { int, invalid, notFound } from "../errors.ts";
import { bodyOf, bool, num, str, oneOf, type Handlers, type RouteDeps } from "./types.ts";

export function archiveRoutes({
  app,
}: RouteDeps): Handlers<
  | "archive.history"
  | "archive.preview"
  | "archive.download"
  | "archive.pin"
  | "archive.retention"
  | "archive.policy"
  | "archive.cleanup"
> {
  const { store } = app;
  const target = (params: Record<string, unknown>) => ({
    kind: oneOf(params.kind, "kind", ["version", "extraction", "evidence"] as const)!,
    id: int(params.id, "id"),
  });
  const preview = (kind: "version" | "extraction" | "evidence", id: number) => {
    const entry = store.evidence.entry(store.trackId, kind, id);
    if (!entry) throw notFound("No archived version in this desk");
    const body = store.evidence.body(store.trackId, kind, id);
    return {
      entry,
      text: body?.subarray(0, 32000).toString("utf8"),
      clipped: body ? body.length > 32000 : false,
    };
  };
  return {
    "archive.retention": (_req, res) =>
      res.set("cache-control", "no-store").json(store.retention.preview()),
    "archive.policy": (req, res) => {
      const body = bodyOf(req);
      const patch = {
        ...(body.ordinaryDays !== undefined
          ? { ordinaryDays: num(body, "ordinaryDays", { min: 1, max: 3650, integer: true }) }
          : {}),
        ...(body.citedDays !== undefined
          ? { citedDays: num(body, "citedDays", { min: 1, max: 3650, integer: true }) }
          : {}),
        ...(body.enforcement !== undefined
          ? {
              enforcement: oneOf(body.enforcement, "enforcement", ["disabled", "enabled"] as const),
            }
          : {}),
        ...(body.storageBudgetBytes !== undefined
          ? { storageBudgetBytes: num(body, "storageBudgetBytes", { min: 1048576, integer: true }) }
          : {}),
      };
      try {
        res.json(
          store.retention.setPolicy(patch, str(body, "previewToken", { optional: true, max: 64 })),
        );
      } catch (error) {
        throw invalid((error as Error).message);
      }
    },
    "archive.cleanup": async (req, res) => {
      const token = str(bodyOf(req), "previewToken", { max: 64 });
      try {
        res.json(await cleanupArchive(app, { previewToken: token }));
      } catch (error) {
        throw invalid((error as Error).message);
      }
    },
    "archive.history": (req, res) => {
      const id = int(req.params.id, "id");
      if (!store.news.card(id)) throw notFound("No card in this desk");
      res.json(store.evidence.history(store.trackId, id));
    },
    "archive.preview": (req, res) => {
      const { kind, id } = target(req.params);
      res.set("cache-control", "no-store").json(preview(kind, id));
    },
    "archive.download": (req, res) => {
      const { kind, id } = target(req.params);
      const entry = store.evidence.entry(store.trackId, kind, id);
      if (!entry) throw notFound("No archived version in this desk");
      const body = store.evidence.body(store.trackId, kind, id);
      if (!body)
        return res.status(410).json({
          error: { code: "not_found", message: "Original expired under retention policy" },
        });
      res
        .set({
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="archive-${kind}-${id}.bin"`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
          "cache-control": "no-store",
        })
        .send(body);
    },
    "archive.pin": (req, res) => {
      const { kind, id } = target(req.params),
        pinned = bool(bodyOf(req), "pinned");
      if (pinned === undefined) throw invalid("pinned is required");
      const entry = store.evidence.entry(store.trackId, kind, id);
      if (!entry) throw notFound("No archived version in this desk");
      if (pinned && entry.expiredAt) throw invalid("An expired original cannot be pinned");
      store.evidence.pin(store.trackId, kind, id, pinned);
      res.json(preview(kind, id));
    },
  };
}
