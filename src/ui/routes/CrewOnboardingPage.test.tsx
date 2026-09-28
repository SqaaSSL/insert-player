import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  buildWhatsAppInviteUrl,
  CrewOnboardingPage,
  resolveCrewMissionStep,
} from './CrewOnboardingPage.tsx';

const baseProps = {
  authStatus: 'signed-in' as const,
  playerName: 'Mara',
  activeCrew: null,
  crews: [],
  fighterId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  fighterPhotoHash: 'rookie-photo',
  onCreateCrew: vi.fn(async (name: string) => ({ id: 'org_crew', name, slug: 'crew' })),
  onSelectCrew: vi.fn(async () => {}),
  onCreateFighter: vi.fn(),
  onCreateStage: vi.fn(),
  onComplete: vi.fn(),
};

describe('Crew onboarding presentation', () => {
  it('finishes a member onboarding after sharing but gives Crew admins the invite mission', () => {
    expect(resolveCrewMissionStep({
      shared: true,
      canInviteCrew: false,
      crewStageReady: false,
      invitationAccepted: false,
    })).toBe('complete');
    expect(resolveCrewMissionStep({
      shared: true,
      canInviteCrew: true,
      crewStageReady: false,
      invitationAccepted: false,
    })).toBe('invite');
    expect(resolveCrewMissionStep({
      shared: true,
      canInviteCrew: true,
      crewStageReady: true,
      invitationAccepted: false,
    })).toBe('invite');
    expect(resolveCrewMissionStep({
      shared: true,
      canInviteCrew: true,
      crewStageReady: true,
      invitationAccepted: true,
    })).toBe('complete');
  });

  it('keeps the existing product surfaces while presenting the game mission sequence', () => {
    const markup = renderToStaticMarkup(<CrewOnboardingPage {...baseProps} />);

    expect(markup).toContain('product-entry');
    expect(markup).toContain('Your first run');
    expect(markup).toContain('Your First Game');
    expect(markup).toContain('1 · Try a game');
    expect(markup).toContain('2 · Create your Rookie');
    expect(markup).toContain('3 · Aura debut');
    expect(markup).toContain('4 · Build a Crew');
    expect(markup).toContain('5 · Invite Player Two');
    expect(markup).toContain('6 · Choose a home stage');
    expect(markup).toContain('Loading your next mission');
    expect(markup).not.toContain('Create Crew &amp; Share Rookie');
    expect(markup).not.toContain('Change branding');
  });

  it('does not offer sharing actions before account progress has loaded', () => {
    const markup = renderToStaticMarkup(
      <CrewOnboardingPage
        {...baseProps}
        activeCrew={{ id: 'org_crew', name: 'Night Shift', slug: 'night-shift' }}
        crews={[{ id: 'org_crew', name: 'Night Shift', slug: 'night-shift', role: 'org:admin' }]}
      />,
    );

    expect(markup).not.toContain('Share With Night Shift');
    expect(markup).toContain('Loading your next mission');
    expect(markup).not.toContain('Make Private');
    expect(markup).not.toContain('Keep Private');
  });

  it('places account creation at the persistence checkpoint', () => {
    const markup = renderToStaticMarkup(
      <CrewOnboardingPage
        {...baseProps}
        authStatus="signed-out"
        onSignIn={vi.fn()}
        onPlayTrial={vi.fn()}
      />,
    );

    expect(markup).toContain('Your First Game');
    expect(markup).toContain('Try Aura');
    expect(markup).toContain('Try Fight');
    expect(markup).not.toContain('Try Rush');
    expect(markup).toContain('Sign In To Continue');
    expect(markup).toContain('Create a Crew · Invite Player Two · Choose one shared stage together');
  });

  it('resumes the real create or debut checkpoint instead of pretending they are done', () => {
    const progress = { shared: false, canInviteCrew: false, crewStageReady: false, invitationAccepted: false };
    expect(resolveCrewMissionStep({ ...progress, hasFighter: false, debutComplete: false })).toBe('create');
    expect(resolveCrewMissionStep({ ...progress, hasFighter: true, debutComplete: false })).toBe('debut');
    expect(resolveCrewMissionStep({ ...progress, hasFighter: true, debutComplete: true })).toBe('crew');
    expect(resolveCrewMissionStep({ ...progress, hasFighter: true, debutComplete: false, serverComplete: true })).toBe('complete');
  });

  it('presents the one-per-Crew stage after inviting the players who should decide it', () => {
    expect(resolveCrewMissionStep({
      shared: true,
      canInviteCrew: true,
      crewStageReady: false,
      invitationAccepted: true,
    })).toBe('stage');
    expect(resolveCrewMissionStep({
      shared: true,
      canInviteCrew: true,
      crewStageReady: true,
      invitationAccepted: false,
    })).toBe('invite');
  });

  it('builds a WhatsApp share with the one-time Crew link and no email step', () => {
    const href = buildWhatsAppInviteUrl(
      'https://insertplayer.ai/join?referral=abc123',
      'Night Shift',
    );
    expect(href).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(decodeURIComponent(href)).toContain('Join my Crew Night Shift');
    expect(decodeURIComponent(href)).toContain('https://insertplayer.ai/join?referral=abc123');
    expect(decodeURIComponent(href).toLowerCase()).not.toContain('email');
  });
});
