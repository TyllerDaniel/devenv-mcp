#!/bin/sh
# Stand-in for the ci-doctor binary: reads the log on stdin and returns a fixed diagnosis.
cat > /dev/null
cat <<'EOF'
{"input_format":"text","total_failures":1,"summary":{"timeout":1},"findings":[{"category":"timeout","test":null,"message":"job exceeded its time limit","evidence":"Error: The operation was canceled.","line":3,"suggestion":"Profile the slow step or raise the timeout."}]}
EOF
exit 1
