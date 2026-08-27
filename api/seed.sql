INSERT INTO approval_modules (module_key, module_name, description, url_slug)
VALUES ('career_path', 'Career Path Approval', 'Review & approve draft Career Architecture (RD/RI/PD/PI) sebelum menjadi data final.', 'career-path-approval.html')
ON CONFLICT (module_key) DO NOTHING;
