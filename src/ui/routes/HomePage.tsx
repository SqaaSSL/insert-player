interface HomePageProps {
  onOpenGallery: () => void;
  onOpenWatchMode: () => void;
  onOpenVsCpu: () => void;
  onOpenVsPlayer: () => void;
}

export function HomePage({
  onOpenGallery,
  onOpenWatchMode,
  onOpenVsCpu,
  onOpenVsPlayer,
}: HomePageProps) {
  return (
    <div className="home-app">
      <div className="home-hero">
        <p className="gallery-eyebrow">Insert Coin</p>
        <h1>AI Street Fighter</h1>
        <p className="home-hero__copy">
          Upload a photo. Forge a fighter. Step into the arcade.
        </p>
      </div>

      <div className="home-menu">
        <button className="home-menu__action is-primary" onClick={onOpenVsCpu}>
          <span>Arcade Mode</span>
          <small>Challenge The CPU Gauntlet</small>
        </button>
        <button className="home-menu__action" onClick={onOpenVsPlayer}>
          <span>Versus</span>
          <small>Local 1P vs 2P Showdown</small>
        </button>
        <button className="home-menu__action" onClick={onOpenWatchMode}>
          <span>Attract Mode</span>
          <small>Watch The CPUs Fight</small>
        </button>
        <button className="home-menu__action is-secondary" onClick={onOpenGallery}>
          <span>Training Room</span>
          <small>Browse Your Roster</small>
        </button>
      </div>
    </div>
  );
}
