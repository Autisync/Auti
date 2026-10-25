-- CallCatch needs UK trades. The UK missed-calls angle came up 2 days in 11; now 5 days in 17 (unless the
-- owner already changed its weight), with a second UK trades angle beyond Merseyside so the same towns are
-- not searched over and over. The Coordinator workflow's "focus: uk-trades" points a single run at them.
UPDATE lead_angle SET weight = 5
 WHERE market = 'uk' AND angle LIKE 'missed calls: plumbers, electricians, roofers, locksmiths%' AND weight = 2;

INSERT INTO lead_angle (market, angle, weight)
SELECT 'uk', 'missed calls: plumbers, heating engineers, electricians, roofers and locksmiths in Greater Manchester, West Yorkshire and the West Midlands whose website or Google profile shows only a mobile number, with no online booking or out-of-hours answering, so callers who reach voicemail ring the next trade', 3
 WHERE NOT EXISTS (SELECT 1 FROM lead_angle WHERE market = 'uk' AND angle LIKE 'missed calls: plumbers, heating engineers%');
