#!/usr/bin/env bash
#
# Copy everything in the journal's S3 bucket to a local directory, as the
# plain files it already is: entries and their attachments under `journal/`,
# documents, the media library, touched derived records and layouts under
# `derived/`, and the published mirror under `public/`.
#
#   npm run export                     # to ~/journal-export-<today>
#   npm run export -- ~/some/folder    # anywhere else, outside this repo
#
# Nothing here goes through the application — it is the `aws s3 sync` that
# `CLAUDE.md` names as the way out, wrapped so it can't be got wrong. The
# entries it produces need no software to read (`requirements.md` §7.3).
#
# Re-running into the same folder only fetches what changed. Files deleted
# from the bucket are left in place locally, deliberately: an export is a
# copy to keep, not a mirror to keep in step.
#
# Uses your own AWS credentials (`aws configure`). The bucket comes from
# `S3_BUCKET` if set, otherwise from `infra/terraform`'s local state.
#
# Written for bash 3.2, which is what macOS ships.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"

bucket="${S3_BUCKET:-}"
if [[ -z "${bucket}" ]]; then
  bucket="$(terraform -chdir="${REPO}/infra/terraform" output -raw bucket_name 2>/dev/null || true)"
fi
if [[ -z "${bucket}" ]]; then
  echo "No bucket: set S3_BUCKET, or run this where infra/terraform's state is." >&2
  exit 1
fi

# `npm run` changes directory to the repository root; INIT_CWD is where it
# was actually typed, which is what a relative destination means.
base="${INIT_CWD:-$PWD}"
dest="${1:-$HOME/journal-export-$(date +%Y-%m-%d)}"
case "${dest}" in
  /*) ;;
  *) dest="${base}/${dest}" ;;
esac

created=0
if [[ ! -d "${dest}" ]]; then
  mkdir -p "${dest}"
  created=1
fi
dest="$(cd "${dest}" && pwd -P)"

# This repository is public. An export landing inside it is one `git add -A`
# away from publishing the whole journal.
case "${dest}/" in
  "${REPO}/"*)
    [[ "${created}" -eq 1 ]] && rmdir "${dest}"
    echo "Refusing to export into ${dest}: it is inside this repository, which is public." >&2
    exit 1
    ;;
esac

echo "Exporting s3://${bucket}/ to ${dest}"
aws s3 sync "s3://${bucket}/" "${dest}/" --only-show-errors

count() { [[ -d "${dest}/$1" ]] && find "${dest}/$1" -type f -name "$2" | wc -l | tr -d ' ' || echo 0; }
echo "entries:   $(count journal '*.md')"
echo "documents: $(count documents '*.md')"
echo "media:     $(count media '*.json')"
echo "Done. Everything under ${dest}/journal is plain markdown; any text editor opens it."
