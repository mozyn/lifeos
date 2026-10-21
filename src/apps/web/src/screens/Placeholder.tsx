export function Placeholder({ title, milestone }: { title: string; milestone: string }) {
  return (
    <div className="page">
      <h1 className="page-title">{title}</h1>
      <section className="card">
        <p className="secondary">
          {title} arrives in milestone {milestone}.
        </p>
      </section>
    </div>
  );
}
