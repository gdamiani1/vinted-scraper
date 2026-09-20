import { absUrl } from './util.js';

/** Normalises the `/api/v2/users/:id` payload into a compact seller profile. */
export function normalizeUser(raw, baseUrl) {
  const u = raw?.user ?? raw ?? {};
  const pos = u.positive_feedback_count ?? 0;
  const neu = u.neutral_feedback_count ?? 0;
  const neg = u.negative_feedback_count ?? 0;
  const total = u.feedback_count ?? pos + neu + neg;
  return {
    id: u.id,
    login: u.login,
    url: u.profile_url ?? absUrl(baseUrl, `/member/${u.id}`),
    about: u.about || undefined,
    business: Boolean(u.business),
    countryCode: u.country_code ?? u.country_iso_code,
    country: u.country_title,
    city: u.city || undefined,
    currency: u.currency,
    itemCount: u.item_count,
    totalItemsCount: u.total_items_count,
    givenItemCount: u.given_item_count,
    takenItemCount: u.taken_item_count,
    followers: u.followers_count,
    following: u.following_count,
    feedbackCount: total,
    positiveFeedback: pos,
    neutralFeedback: neu,
    negativeFeedback: neg,
    feedbackReputation: u.feedback_reputation,
    positiveRatio: total ? Number((pos / total).toFixed(3)) : undefined,
    lastLoggedOn: u.last_loged_on_ts ?? u.last_logged_on_ts,
    isOnHoliday: Boolean(u.is_on_holiday),
    accountStatus: u.account_status,
    photo: u.photo?.url,
    createdAt: u.created_at,
  };
}
