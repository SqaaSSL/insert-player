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
    expect(markup).toContain('Aura onboarding');
    expect(markup).toContain('Build Your Crew');
    expect(markup).toContain('1 · Learn Aura');
    expect(markup).toContain('2 · Create your Rookie');
    expect(markup).toContain('3 · Aura debut');
    expect(markup).toContain('4 · Build a Crew');
    expect(markup).toContain('5 · Invite Player Two');
    expect(markup).toContain('6 · Choose a home stage');
    expect(markup).toContain('Create Crew &amp; Share Rookie');
    expect(markup).not.toContain('Change branding');
  });

  it('offers Crew as the minimum visible sharing destination', () => {
    const markup = renderToStaticMarkup(
      <CrewOnboardingPage
        {...baseProps}
        activeCrew={{ id: 'org_crew', name: 'Night Shift', slug: 'night-shift' }}
        crews={[{ id: 'org_crew', name: 'Night Shift', slug: 'night-shift', role: 'org:admin' }]}
      />,
    );

    expect(markup).toContain('Share With Night Shift');
    expect(markup).toContain('original photo and raw files stay out of the shared copy');
    expect(markup).not.toContain('Make Private');
    expect(markup).not.toContain('Keep Private');
  });

  it('places account creation at the persistence checkpoint', () => {
    const markup = renderToStaticMarkup(
      <CrewOnboardingPage
        {...baseProps}
        authStatus="signed-out"
        onSignIn={vi.fn()}
      />,
    );

    expect(markup).toContain('Save Your Crew');
    expect(markup).toContain('Sign In To Continue');
    expect(markup).toContain('Create a Crew · Invite Player Two · Choose one shared stage together');
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
