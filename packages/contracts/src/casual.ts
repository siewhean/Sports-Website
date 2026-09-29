/** Unlisted casual games are separate from published competition matches. */
export type CasualSportId = "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball";
export type CasualGameSettings = {
  sport_id: CasualSportId;
  home_name: string;
  away_name: string;
  target_points?: number;
  best_of_sets?: number;
  period_minutes?: number;
};
export type CasualGame = CasualGameSettings & {
  id: string;
  home_score: number;
  away_score: number;
  home_sets: number;
  away_sets: number;
  current_set: number;
  sets: { home: number; away: number }[];
  elapsed_seconds: number;
  timer_running: boolean;
  timer_started_at: string | null;
  status: "live" | "final";
  version: number;
  updated_at: string;
};
export type CasualGameCreated = { game: CasualGame; host_token: string; viewer_token: string };
export type CasualScoreAction = { side: "home" | "away"; points?: 1 | 2 | 3 };
export type CasualFriend = { id: string; display_name: string };
export type CasualFriendRequest = {
  id: string;
  sender_id: string;
  recipient_id: string;
  status: "pending";
  created_at: string;
  sender_name: string;
};
