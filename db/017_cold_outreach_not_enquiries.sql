-- Prospects from a cold-outreach list that were added to the CRM the same day the sync first saw them were taken for
-- new enquiries ("reply today"). They are in an outreach sequence, not waiting for an answer: drop that note so the
-- drafts read as a first approach, not as a reply.
UPDATE clients
   SET notes = NULL
 WHERE outreach_step IS NOT NULL
   AND notes LIKE 'New enquiry in the CRM on %';
