import type { ReviewerIdentity } from "./api";

const fallbackReviewer: ReviewerIdentity = {
  name: "Review Team",
  role: "Reviewer",
  initials: "RT",
};

export function ReviewerBadge({
  identity,
}: {
  identity?: ReviewerIdentity | null;
}) {
  const reviewer = identity ?? fallbackReviewer;
  return (
    <div className="reviewer" aria-label={`Current reviewer: ${reviewer.name}`}>
      <div className="avatar" aria-hidden="true">
        {reviewer.initials}
      </div>
      <div>
        <strong>{reviewer.name}</strong>
        <span>{reviewer.role}</span>
      </div>
    </div>
  );
}
