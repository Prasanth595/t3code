import { View } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";

const SIZE = 96;

export function EmptyOrb() {
  return (
    <View className="mb-6 items-center" style={{ opacity: 0.85 }}>
      <Svg width={SIZE} height={SIZE}>
        <Defs>
          <RadialGradient id="empty-orb" cx="35%" cy="30%" r="75%">
            <Stop offset="0" stopColor="#f3e8ff" />
            <Stop offset="0.45" stopColor="#c7d2fe" />
            <Stop offset="1" stopColor="#a5f3fc" />
          </RadialGradient>
        </Defs>
        <Circle cx={SIZE / 2} cy={SIZE / 2} r={SIZE / 2} fill="url(#empty-orb)" />
      </Svg>
    </View>
  );
}
